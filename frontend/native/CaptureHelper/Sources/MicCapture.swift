import AudioToolbox
import AVFoundation
import CoreAudio
import ExceptionCatcher
import Foundation

/// Microphone only. Voice processing stays off so a headset is not forced into call mode.
final class MicCapture: MicrophoneCapturing, @unchecked Sendable {
  var onBuffer: ((AVAudioPCMBuffer, UInt64) -> Void)?
  var onConfigurationChange: (() -> Void)?

  private var engine: AVAudioEngine?
  private var generation = 0
  private var configObserver: NSObjectProtocol?
  var isRunning: Bool { engine != nil }

  func start(device: AudioDeviceInfo) throws {
    generation += 1
    let token = generation
    AudioDevices.logInputMute(device)
    let audioEngine = AVAudioEngine()
    let input = audioEngine.inputNode
    try? input.setVoiceProcessingEnabled(false)
    try pin(input, to: device, label: "mic pin")
    audioEngine.prepare()
    do {
      try pin(input, to: device, label: "mic pin after prepare")
    } catch let error as NSError where error.code == Int(kAudioUnitErr_Initialized) {
      CaptureLog.line("mic pin after prepare skipped")
    }
    try audioEngine.start()
    let hardware = input.inputFormat(forBus: 0)
    let output = input.outputFormat(forBus: 0)
    CaptureLog.line(
      "mic format in sr=\(hardware.sampleRate) ch=\(hardware.channelCount) common=\(hardware.commonFormat.rawValue) out sr=\(output.sampleRate) ch=\(output.channelCount) common=\(output.commonFormat.rawValue) device=\(device.summary)"
    )
    guard let format = Self.tapFormat(output: output, hardware: hardware, device: device) else {
      audioEngine.stop()
      throw NSError(domain: "CaptureHelper", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "mic_format",
      ])
    }
    audioEngine.stop()
    guard token == generation else {
      audioEngine.stop()
      throw NSError(domain: "CaptureHelper", code: 5, userInfo: [
        NSLocalizedDescriptionKey: "mic_superseded",
      ])
    }
    do {
      try pin(input, to: device, label: "mic pin before tap")
    } catch let error as NSError where error.code == Int(kAudioUnitErr_Initialized) {
      CaptureLog.line("mic pin before tap skipped")
    }
    input.removeTap(onBus: 0)
    let exception = PithCatchException {
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, time in
        guard let self, self.generation == token else { return }
        let host = time.isHostTimeValid ? time.hostTime : mach_absolute_time()
        self.onBuffer?(buffer, host)
      }
    }
    if let exception {
      audioEngine.stop()
      throw NSError(domain: "CaptureHelper", code: Int(kAudioUnitErr_FormatNotSupported), userInfo: [
        NSLocalizedDescriptionKey: "mic_tap \(exception.reason ?? exception.name.rawValue)",
      ])
    }
    do {
      try audioEngine.start()
    } catch {
      audioEngine.stop()
      throw error
    }
    guard token == generation else {
      audioEngine.stop()
      throw NSError(domain: "CaptureHelper", code: 5, userInfo: [
        NSLocalizedDescriptionKey: "mic_superseded",
      ])
    }
    watch(audioEngine, token: token)
    engine = audioEngine
  }

  /// installTap wants the engine's float output format. AirPods HFP reports a 24 kHz
  /// hardware format that Core Audio rejects with -10868.
  private static func tapFormat(
    output: AVAudioFormat,
    hardware: AVAudioFormat,
    device: AudioDeviceInfo
  ) -> AVAudioFormat? {
    if output.sampleRate > 0, output.channelCount > 0, output.commonFormat != .otherFormat {
      return output
    }
    let rate = hardware.sampleRate > 0 ? hardware.sampleRate : device.sampleRate
    let channels = hardware.channelCount > 0 ? hardware.channelCount : device.channels
    guard rate > 0, channels > 0 else { return nil }
    return AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: rate,
      channels: channels,
      interleaved: false
    )
  }

  func stop() {
    generation += 1
    if let configObserver {
      NotificationCenter.default.removeObserver(configObserver)
      self.configObserver = nil
    }
    guard let engine else { return }
    let stopping = engine
    self.engine = nil
    DispatchQueue.global(qos: .userInitiated).async {
      stopping.inputNode.removeTap(onBus: 0)
      if stopping.isRunning { stopping.stop() }
    }
  }

  private func watch(_ audioEngine: AVAudioEngine, token: Int) {
    if let configObserver {
      NotificationCenter.default.removeObserver(configObserver)
    }
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: audioEngine,
      queue: nil
    ) { [weak self] _ in
      guard let self, self.generation == token else { return }
      self.onConfigurationChange?()
    }
  }

  private func pin(_ input: AVAudioInputNode, to device: AudioDeviceInfo, label: String) throws {
    guard let audioUnit = input.audioUnit else { return }
    var deviceID = device.id
    let status = AudioUnitSetProperty(
      audioUnit,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global,
      0,
      &deviceID,
      UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    CaptureLog.line("\(label) status=\(status) id=\(device.id) uid=\(device.uid)")
    if status != noErr {
      throw NSError(domain: "CaptureHelper", code: Int(status), userInfo: [
        NSLocalizedDescriptionKey: "\(label) \(status)",
      ])
    }
  }
}
