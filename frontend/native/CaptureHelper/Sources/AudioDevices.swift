import CoreAudio
import Foundation

/// Reads the default input and output. No reconnect policy.
enum AudioDevices {
  static func preferredInput() -> AudioDeviceInfo? {
    if let current = device(
      defaultID(kAudioHardwarePropertyDefaultInputDevice),
      scope: kAudioDevicePropertyScopeInput
    ), !isOutputOnly(current.uid) {
      return current
    }
    return builtInInput()
  }

  static func defaultOutput() -> AudioDeviceInfo? {
    device(defaultID(kAudioHardwarePropertyDefaultOutputDevice), scope: kAudioDevicePropertyScopeOutput)
  }

  static func snapshot() -> DeviceSnapshot {
    DeviceSnapshot(input: preferredInput(), output: defaultOutput())
  }

  static func input(uid: String) -> AudioDeviceInfo? {
    guard !uid.isEmpty else { return nil }
    return devices(scope: kAudioDevicePropertyScopeInput).first { $0.uid == uid }
  }

  static func output(uid: String) -> AudioDeviceInfo? {
    guard !uid.isEmpty else { return nil }
    return devices(scope: kAudioDevicePropertyScopeOutput).first { $0.uid == uid }
  }

  /// Reads mute state. Does not change the system volume or the default device.
  static func logInputMute(_ device: AudioDeviceInfo) {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyMute,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var muted: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(device.id, &address, 0, nil, &size, &muted)
    if status == noErr {
      CaptureLog.line("mic input mute=\(muted) uid=\(device.uid)")
    } else {
      CaptureLog.line("mic input mute=unknown status=\(status) uid=\(device.uid)")
    }
  }

  static func observe(_ queue: DispatchQueue, _ onChange: @escaping () -> Void) -> () -> Void {
    let system = AudioObjectID(kAudioObjectSystemObject)
    let selectors = [
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioHardwarePropertyDefaultOutputDevice,
      kAudioHardwarePropertyDevices,
    ]
    var tokens: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    for selector in selectors {
      var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let block: AudioObjectPropertyListenerBlock = { _, _ in onChange() }
      if AudioObjectAddPropertyListenerBlock(system, &address, queue, block) == noErr {
        tokens.append((address, block))
      }
    }
    return {
      for index in tokens.indices {
        var address = tokens[index].0
        AudioObjectRemovePropertyListenerBlock(system, &address, queue, tokens[index].1)
      }
    }
  }

  private static func builtInInput() -> AudioDeviceInfo? {
    let inputs = devices(scope: kAudioDevicePropertyScopeInput).filter { !isOutputOnly($0.uid) }
    return inputs.first { $0.uid == "BuiltInMicrophoneDevice" }
      ?? inputs.first { $0.transport == kAudioDeviceTransportTypeBuiltIn }
  }

  private static func isOutputOnly(_ uid: String) -> Bool {
    let lower = uid.lowercased()
    return lower.contains("output") && !lower.contains(":input")
  }

  private static func devices(scope: AudioObjectPropertyScope) -> [AudioDeviceInfo] {
    guard let ids = allIDs() else { return [] }
    return ids.compactMap { device($0, scope: scope) }
  }

  private static func device(_ id: AudioDeviceID?, scope: AudioObjectPropertyScope) -> AudioDeviceInfo? {
    guard let id, id != kAudioObjectUnknown else { return nil }
    let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) ?? ""
    let name = stringProperty(id, kAudioObjectPropertyName) ?? ""
    if uid.isEmpty, name.isEmpty { return nil }
    if scope == kAudioDevicePropertyScopeInput, isOutputOnly(uid) { return nil }
    let format = streamFormat(id, scope: scope)
    return AudioDeviceInfo(
      id: id,
      uid: uid.isEmpty ? String(id) : uid,
      name: name.isEmpty ? uid : name,
      transport: transport(id),
      sampleRate: format.rate,
      channels: format.channels
    )
  }

  private static func allIDs() -> [AudioDeviceID]? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
      return nil
    }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
      return nil
    }
    return ids
  }

  private static func defaultID(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var id = AudioDeviceID()
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id
    ) == noErr else { return nil }
    return id
  }

  private static func transport(_ id: AudioDeviceID) -> UInt32 {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyTransportType,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return 0 }
    return value
  }

  private static func streamFormat(
    _ id: AudioDeviceID,
    scope: AudioObjectPropertyScope
  ) -> (rate: Double, channels: UInt32) {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: scope,
      mElement: kAudioObjectPropertyElementMain
    )
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &asbd) == noErr else { return (0, 0) }
    return (asbd.mSampleRate, asbd.mChannelsPerFrame)
  }

  private static func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return nil }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<CFString>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return nil }
    return raw.load(as: CFString.self) as String
  }

}
