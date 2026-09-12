import CoreAudio
import Foundation

struct AudioInputDevice {
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

  var isHandsFree: Bool {
    isBluetooth && (channels < 2 || (sampleRate > 0 && sampleRate <= 24_000))
  }

  var isUsableInput: Bool {
    if uid.lowercased().contains("output") {
      return false
    }
    if uid.lowercased().contains(":input") {
      return true
    }
    return sampleRate > 0 && channels > 0
  }

  var transportName: String {
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn:
      return "builtin"
    case kAudioDeviceTransportTypeBluetooth:
      return "bluetooth"
    case kAudioDeviceTransportTypeBluetoothLE:
      return "bluetooth_le"
    case kAudioDeviceTransportTypeUSB:
      return "usb"
    case kAudioDeviceTransportTypeDisplayPort:
      return "displayport"
    case kAudioDeviceTransportTypeHDMI:
      return "hdmi"
    case kAudioDeviceTransportTypeVirtual:
      return "virtual"
    case kAudioDeviceTransportTypeAggregate:
      return "aggregate"
    default:
      return String(transport, radix: 16)
    }
  }

  var summary: String {
    "name=\(name) uid=\(uid) transport=\(transportName) sr=\(sampleRate) ch=\(channels) hfp=\(isHandsFree)"
  }
}

enum CaptureLog {
  static func line(_ message: String) {
    fputs("\(message)\n", stderr)
    fflush(stderr)
  }
}

enum AudioDevices {
  static func defaultInput() -> AudioInputDevice? {
    device(defaultDevice(kAudioHardwarePropertyDefaultInputDevice), scope: kAudioDevicePropertyScopeInput)
  }

  static func defaultOutput() -> AudioInputDevice? {
    device(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice), scope: kAudioDevicePropertyScopeOutput)
  }

  /// Follow the macOS default input (AirPods, USB, built-in). Never pick an
  /// output-only device such as the headphone jack.
  static func preferredInput() -> AudioInputDevice? {
    let systemDefault = defaultInput()
    if let systemDefault, systemDefault.isUsableInput {
      return systemDefault
    }
    return builtInInput()
  }

  static func builtInInput() -> AudioInputDevice? {
    let inputs = devices(scope: kAudioDevicePropertyScopeInput).filter(\.isUsableInput)
    if let mic = inputs.first(where: { $0.uid == "BuiltInMicrophoneDevice" }) {
      return mic
    }
    return inputs.first { $0.transport == kAudioDeviceTransportTypeBuiltIn }
  }

  static func observeDefaults(queue: DispatchQueue, onChange: @escaping (String) -> Void) -> () -> Void {
    let system = AudioObjectID(kAudioObjectSystemObject)
    let selectors = [
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioHardwarePropertyDefaultOutputDevice,
    ]
    var tokens: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    for selector in selectors {
      var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let reason: String
      switch selector {
      case kAudioHardwarePropertyDefaultInputDevice:
        reason = "default_input"
      case kAudioHardwarePropertyDefaultOutputDevice:
        reason = "default_output"
      default:
        reason = "devices"
      }
      let block: AudioObjectPropertyListenerBlock = { _, _ in
        onChange(reason)
      }
      let status = AudioObjectAddPropertyListenerBlock(system, &address, queue, block)
      if status == noErr {
        tokens.append((address, block))
      } else {
        CaptureLog.line("audio listener failed selector=\(selector) status=\(status)")
      }
    }
    return {
      var copy = tokens
      for index in copy.indices {
        var address = copy[index].0
        AudioObjectRemovePropertyListenerBlock(
          system,
          &address,
          queue,
          copy[index].1
        )
      }
      copy.removeAll()
    }
  }

  private static func devices(scope: AudioObjectPropertyScope) -> [AudioInputDevice] {
    guard let ids = allDeviceIDs() else { return [] }
    return ids.compactMap { device($0, scope: scope) }
  }

  private static func device(
    _ id: AudioDeviceID?,
    scope: AudioObjectPropertyScope
  ) -> AudioInputDevice? {
    guard let id, id != kAudioObjectUnknown else { return nil }
    let name = stringProperty(id, kAudioObjectPropertyName) ?? ""
    let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) ?? String(id)
    if name.isEmpty, uid.isEmpty {
      return nil
    }
    let format = streamFormat(id, scope: scope)
    if scope == kAudioDevicePropertyScopeInput, uid.lowercased().contains("output") {
      return nil
    }
    if scope == kAudioDevicePropertyScopeInput, format.sampleRate <= 0 || format.channels == 0 {
      let transport = transportType(id)
      let bluetooth = transport == kAudioDeviceTransportTypeBluetooth
        || transport == kAudioDeviceTransportTypeBluetoothLE
      if !bluetooth, !uid.lowercased().contains(":input") {
        return nil
      }
    }
    return AudioInputDevice(
      id: id,
      uid: uid,
      name: name.isEmpty ? uid : name,
      transport: transportType(id),
      sampleRate: format.sampleRate,
      channels: format.channels
    )
  }

  private static func allDeviceIDs() -> [AudioDeviceID]? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size)
    guard status == noErr, size > 0 else { return nil }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    status = AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids)
    guard status == noErr else { return nil }
    return ids
  }

  private static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var deviceID = AudioDeviceID()
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &address,
      0,
      nil,
      &size,
      &deviceID
    )
    guard status == noErr else { return nil }
    return deviceID
  }

  private static func transportType(_ deviceID: AudioDeviceID) -> UInt32 {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyTransportType,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var transport = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &transport)
    return status == noErr ? transport : 0
  }

  private static func streamFormat(
    _ deviceID: AudioDeviceID,
    scope: AudioObjectPropertyScope
  ) -> (sampleRate: Double, channels: UInt32) {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: scope,
      mElement: kAudioObjectPropertyElementMain
    )
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &asbd)
    guard status == noErr else { return (0, 0) }
    return (asbd.mSampleRate, asbd.mChannelsPerFrame)
  }

  private static func stringProperty(
    _ deviceID: AudioDeviceID,
    _ selector: AudioObjectPropertySelector
  ) -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
    guard status == noErr, size > 0 else { return nil }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<CFString>.alignment)
    defer { raw.deallocate() }
    status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, raw)
    guard status == noErr else { return nil }
    let cf = raw.load(as: CFString.self)
    return cf as String
  }
}
