import CoreAudio
import Foundation

struct AudioInputDevice {
  let uid: String
  let name: String
}

enum AudioDevices {
  static func defaultInput() -> AudioInputDevice? {
    guard let id = defaultDevice(kAudioHardwarePropertyDefaultInputDevice),
          id != kAudioObjectUnknown
    else {
      return nil
    }
    let name = stringProperty(id, kAudioObjectPropertyName) ?? ""
    let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) ?? String(id)
    if name.isEmpty, uid.isEmpty {
      return nil
    }
    return AudioInputDevice(uid: uid, name: name.isEmpty ? uid : name)
  }

  static func observeDefaults(queue: DispatchQueue, onChange: @escaping (String) -> Void) -> () -> Void {
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
        fputs("audio listener failed selector=\(selector) status=\(status)\n", stderr)
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
