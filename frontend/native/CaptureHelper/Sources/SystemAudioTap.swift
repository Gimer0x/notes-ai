import AVFoundation
import CoreAudio
import Foundation

/// Mix of every process's playback (YouTube, Netflix, Zoom, …) without capturing
/// the screen. That is why DRM video can stay visible. Do not mute tapped apps.
@available(macOS 14.2, *)
final class SystemAudioTap {
  var onBuffer: ((AVAudioPCMBuffer) -> Void)?

  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var format: AVAudioFormat?
  private let ioQueue = DispatchQueue(label: "dev.pith.system-audio.io")

  func start(outputUID: String? = nil) throws {
    if outputUID != nil {
      CaptureLog.line("system tap ignoring device UID; always global so playback is not interrupted")
    }
    try startOnce(outputUID: nil)
  }

  private func startOnce(outputUID: String?) throws {
    let uuid = UUID()
    var excluded: [AudioObjectID] = []
    if let selfProcess = Self.audioProcessObject(for: getpid()) {
      excluded.append(selfProcess)
    }

    let description: CATapDescription
    if let outputUID, !outputUID.isEmpty {
      description = CATapDescription(
        excludingProcesses: excluded,
        deviceUID: outputUID,
        stream: 0
      )
      CaptureLog.line("system tap output=\(outputUID)")
    } else {
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
      CaptureLog.line("system tap global")
    }
    description.uuid = uuid
    description.name = "Pith System Audio"
    description.isPrivate = true
    description.muteBehavior = .unmuted

    var tap = AudioObjectID(kAudioObjectUnknown)
    var tapStatus = AudioHardwareCreateProcessTap(description, &tap)
    CaptureLog.line("system tap create status=\(tapStatus) id=\(tap)")
    if tapStatus != noErr || tap == kAudioObjectUnknown, outputUID != nil {
      CaptureLog.line("device tap failed status=\(tapStatus), using global tap")
      let fallback = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
      fallback.uuid = uuid
      fallback.name = "Pith System Audio"
      fallback.isPrivate = true
      fallback.muteBehavior = .unmuted
      tapStatus = AudioHardwareCreateProcessTap(fallback, &tap)
      CaptureLog.line("system tap global fallback status=\(tapStatus) id=\(tap)")
    }
    guard tapStatus == noErr, tap != kAudioObjectUnknown else {
      throw Self.error("process_tap", tapStatus)
    }
    tapID = tap

    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Pith System Audio Aggregate",
      kAudioAggregateDeviceUIDKey: "dev.pith.tap.\(uuid.uuidString)",
      kAudioAggregateDeviceIsPrivateKey: 1,
      kAudioAggregateDeviceIsStackedKey: 0,
      kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapUIDKey: uuid.uuidString,
        kAudioSubTapDriftCompensationKey: true,
      ]],
    ]

    var agg = AudioObjectID(kAudioObjectUnknown)
    let aggStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &agg)
    CaptureLog.line("system tap aggregate status=\(aggStatus) id=\(agg)")
    guard aggStatus == noErr, agg != kAudioObjectUnknown else {
      stop()
      throw Self.error("aggregate", aggStatus)
    }
    aggregateID = agg

    guard let format = Self.inputFormat(device: agg) else {
      stop()
      throw Self.error("tap_format", -1)
    }
    self.format = format
    CaptureLog.line(
      "system tap sampleRate=\(format.sampleRate) channels=\(format.channelCount) interleaved=\(format.isInterleaved)"
    )

    var procID: AudioDeviceIOProcID?
    let procStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, agg, ioQueue) { [weak self] _, inputData, _, _, _ in
      guard let self, let format = self.format else { return }
      if let buffer = Self.pcmBuffer(from: inputData.pointee, format: format) {
        self.onBuffer?(buffer)
      }
    }
    guard procStatus == noErr, let procID else {
      stop()
      throw Self.error("ioproc", procStatus)
    }
    ioProcID = procID

    let startStatus = AudioDeviceStart(agg, procID)
    CaptureLog.line("system tap AudioDeviceStart status=\(startStatus)")
    guard startStatus == noErr else {
      stop()
      throw Self.error("tap_start", startStatus)
    }
  }

  func stop() {
    if let ioProcID, aggregateID != kAudioObjectUnknown {
      AudioDeviceStop(aggregateID, ioProcID)
      AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
    }
    ioProcID = nil
    if aggregateID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
    format = nil
  }

  deinit {
    stop()
  }

  private static func inputFormat(device: AudioObjectID) -> AVAudioFormat? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &asbd)
    guard status == noErr else { return nil }
    return AVAudioFormat(streamDescription: &asbd)
  }

  private static func pcmBuffer(from list: AudioBufferList, format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let asbd = format.streamDescription.pointee
    guard asbd.mBytesPerFrame > 0 else { return nil }
    let frames = list.mBuffers.mDataByteSize / asbd.mBytesPerFrame
    guard frames > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))
    else {
      return nil
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    let destList = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    guard let srcData = list.mBuffers.mData, destList.count > 0, let dstData = destList[0].mData else {
      return nil
    }
    let byteCount = min(Int(list.mBuffers.mDataByteSize), Int(destList[0].mDataByteSize))
    memcpy(dstData, srcData, byteCount)
    destList[0].mDataByteSize = UInt32(byteCount)
    return buffer
  }

  private static func audioProcessObject(for pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var processPid = pid
    var objectID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      UInt32(MemoryLayout<pid_t>.size),
      &processPid,
      &size,
      &objectID
    )
    guard status == noErr, objectID != kAudioObjectUnknown else { return nil }
    return objectID
  }

  private static func error(_ key: String, _ status: OSStatus) -> NSError {
    NSError(domain: "CaptureHelper", code: Int(status), userInfo: [
      NSLocalizedDescriptionKey: "\(key) \(status)",
    ])
  }
}
