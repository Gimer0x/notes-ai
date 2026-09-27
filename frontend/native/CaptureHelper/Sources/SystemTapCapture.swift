import AVFoundation
import CoreAudio
import Foundation

/// Global process tap. Never attached to an output device UID.
/// ScreenCaptureKit is not used: display capture blanks DRM video.
final class SystemTapCapture: SystemAudioCapturing, @unchecked Sendable {
  var onBuffer: ((AVAudioPCMBuffer, UInt64) -> Void)?

  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var ioProc: AudioDeviceIOProcID?
  private var format: AVAudioFormat?
  private let queue = DispatchQueue(label: "dev.pith.system-audio.io")

  var isRunning: Bool { tapID != kAudioObjectUnknown }

  func start() throws {
    stop()
    let uuid = UUID()
    var excluded: [AudioObjectID] = []
    if let selfProcess = Self.processObject(getpid()) {
      excluded.append(selfProcess)
    }
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
    description.uuid = uuid
    description.name = "Pith System Audio"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    CaptureLog.line("system tap global")

    var tap = AudioObjectID(kAudioObjectUnknown)
    let tapStatus = AudioHardwareCreateProcessTap(description, &tap)
    CaptureLog.line("system tap create status=\(tapStatus) id=\(tap)")
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
    var aggregateID = AudioObjectID(kAudioObjectUnknown)
    let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
    CaptureLog.line("system tap aggregate status=\(aggregateStatus) id=\(aggregateID)")
    guard aggregateStatus == noErr, aggregateID != kAudioObjectUnknown else {
      stop()
      throw Self.error("aggregate", aggregateStatus)
    }
    self.aggregateID = aggregateID

    guard let format = Self.inputFormat(aggregateID) else {
      stop()
      throw Self.error("tap_format", -1)
    }
    self.format = format
    CaptureLog.line(
      "system tap sampleRate=\(format.sampleRate) channels=\(format.channelCount) interleaved=\(format.isInterleaved)"
    )

    var proc: AudioDeviceIOProcID?
    let procStatus = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, queue) { [weak self] now, inputData, inputTime, _, _ in
      guard let self, let format = self.format else { return }
      let host = Self.hostTime(inputTime, fallback: now)
      if let buffer = Self.pcmBuffer(inputData.pointee, format: format) {
        self.onBuffer?(buffer, host)
      }
    }
    guard procStatus == noErr, let proc else {
      stop()
      throw Self.error("ioproc", procStatus)
    }
    ioProc = proc
    let startStatus = AudioDeviceStart(aggregateID, proc)
    CaptureLog.line("system tap AudioDeviceStart status=\(startStatus)")
    guard startStatus == noErr else {
      stop()
      throw Self.error("tap_start", startStatus)
    }
  }

  func stop() {
    if let ioProc, aggregateID != kAudioObjectUnknown {
      AudioDeviceStop(aggregateID, ioProc)
      AudioDeviceDestroyIOProcID(aggregateID, ioProc)
    }
    ioProc = nil
    if aggregateID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = kAudioObjectUnknown
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = kAudioObjectUnknown
    }
    format = nil
  }

  deinit { stop() }

  private static func hostTime(
    _ stamp: UnsafePointer<AudioTimeStamp>,
    fallback: UnsafePointer<AudioTimeStamp>
  ) -> UInt64 {
    if stamp.pointee.mFlags.contains(.hostTimeValid) {
      return stamp.pointee.mHostTime
    }
    if fallback.pointee.mFlags.contains(.hostTimeValid) {
      return fallback.pointee.mHostTime
    }
    return mach_absolute_time()
  }

  private static func inputFormat(_ device: AudioObjectID) -> AVAudioFormat? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &asbd) == noErr else { return nil }
    return AVAudioFormat(streamDescription: &asbd)
  }

  private static func pcmBuffer(_ list: AudioBufferList, format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let asbd = format.streamDescription.pointee
    guard asbd.mBytesPerFrame > 0 else { return nil }
    let frames = list.mBuffers.mDataByteSize / asbd.mBytesPerFrame
    guard frames > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))
    else { return nil }
    buffer.frameLength = AVAudioFrameCount(frames)
    let dest = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    guard let source = list.mBuffers.mData, dest.count > 0, let data = dest[0].mData else { return nil }
    let bytes = min(Int(list.mBuffers.mDataByteSize), Int(dest[0].mDataByteSize))
    memcpy(data, source, bytes)
    dest[0].mDataByteSize = UInt32(bytes)
    return buffer
  }

  private static func processObject(_ pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var processPid = pid
    var objectID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      UInt32(MemoryLayout<pid_t>.size),
      &processPid,
      &size,
      &objectID
    ) == noErr, objectID != kAudioObjectUnknown else { return nil }
    return objectID
  }

  private static func error(_ key: String, _ status: OSStatus) -> NSError {
    NSError(domain: "CaptureHelper", code: Int(status), userInfo: [
      NSLocalizedDescriptionKey: "\(key) \(status)",
    ])
  }
}
