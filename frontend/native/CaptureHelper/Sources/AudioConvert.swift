import AVFoundation

enum HostClock {
  static func seconds(from earlier: UInt64, to later: UInt64) -> Double {
    guard later > earlier else { return 0 }
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    let nanos = Double(later - earlier) * Double(info.numer) / Double(info.denom)
    return nanos / 1_000_000_000
  }
}

enum AudioConvert {
  private static let mono16k = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(WavWriter.sampleRate),
    channels: 1,
    interleaved: false
  )!

  /// Copy the callback buffer before it is reused. Runs on the audio thread.
  static func copyMono(_ buffer: AVAudioPCMBuffer) -> (floats: [Float], sampleRate: Double)? {
    guard let mono = mixdown(buffer), let source = mono.floatChannelData?[0] else { return nil }
    let count = Int(mono.frameLength)
    guard count > 0 else { return nil }
    return (Array(UnsafeBufferPointer(start: source, count: count)), mono.format.sampleRate)
  }

  static func int16Mono16k(
    _ floats: [Float],
    sampleRate: Double,
    converter: inout AVAudioConverter?
  ) -> [Int16] {
    guard !floats.isEmpty, sampleRate > 0 else { return [] }
    if abs(sampleRate - mono16k.sampleRate) < 1 {
      return floats.map { Int16(max(-1, min(1, $0)) * Float(Int16.max)) }
    }
    guard let mono = buffer(floats, sampleRate: sampleRate) else {
      return resampleLinear(floats, from: sampleRate, to: mono16k.sampleRate)
    }
    if converter == nil || abs((converter?.inputFormat.sampleRate ?? 0) - sampleRate) > 1 {
      converter = AVAudioConverter(from: mono.format, to: mono16k)
    }
    guard let converter else {
      return resampleLinear(floats, from: sampleRate, to: mono16k.sampleRate)
    }
    let frames = AVAudioFrameCount((Double(mono.frameLength) * mono16k.sampleRate / sampleRate).rounded(.up) + 64)
    guard let output = AVAudioPCMBuffer(pcmFormat: mono16k, frameCapacity: frames) else { return [] }
    var error: NSError?
    var fed = false
    let status = converter.convert(to: output, error: &error) { _, outStatus in
      if fed {
        outStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      outStatus.pointee = .haveData
      return mono
    }
    if error != nil || status == .error {
      converter.reset()
      return resampleLinear(floats, from: sampleRate, to: mono16k.sampleRate)
    }
    // A streaming converter may keep the first frames as priming. That is not a failure.
    if output.frameLength == 0 { return [] }
    return int16(output)
  }

  static func level(_ samples: [Int16]) -> Double {
    guard !samples.isEmpty else { return 0 }
    var sum = 0.0
    for sample in samples {
      let value = Double(sample) / 32768
      sum += value * value
    }
    let rms = sqrt(sum / Double(samples.count))
    if rms < 0.004 { return 0 }
    return min(1, (rms - 0.004) * 14)
  }

  static func mix(_ mic: [Int16], _ system: [Int16]) -> [Int16] {
    let count = max(mic.count, system.count)
    guard count > 0 else { return [] }
    return (0..<count).map { index in
      let left = index < mic.count ? Int32(mic[index]) : 0
      let right = index < system.count ? Int32(system[index]) : 0
      let sum = left + right
      if sum > 32767 || sum < -32768 {
        return Int16(clamping: sum / 2)
      }
      return Int16(clamping: sum)
    }
  }

  private static func mixdown(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard frames > 0, channels > 0,
          let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: buffer.format.sampleRate,
            channels: 1,
            interleaved: false
          ),
          let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let destination = output.floatChannelData?[0]
    else { return nil }
    output.frameLength = AVAudioFrameCount(frames)
    let scale = 1 / Float(channels)
    if let floats = buffer.floatChannelData {
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channels {
          sum += buffer.format.isInterleaved
            ? floats[0][frame * channels + channel]
            : floats[channel][frame]
        }
        destination[frame] = sum * scale
      }
      return output
    }
    if let ints = buffer.int16ChannelData {
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channels {
          let sample = buffer.format.isInterleaved
            ? ints[0][frame * channels + channel]
            : ints[channel][frame]
          sum += Float(sample) / 32768
        }
        destination[frame] = sum * scale
      }
      return output
    }
    return nil
  }

  private static func buffer(_ floats: [Float], sampleRate: Double) -> AVAudioPCMBuffer? {
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    ), let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(floats.count)),
      let destination = output.floatChannelData?[0]
    else { return nil }
    output.frameLength = AVAudioFrameCount(floats.count)
    floats.withUnsafeBufferPointer { source in
      destination.update(from: source.baseAddress!, count: floats.count)
    }
    return output
  }

  private static func resampleLinear(
    _ source: [Float],
    from sourceRate: Double,
    to targetRate: Double
  ) -> [Int16] {
    guard sourceRate > 0, targetRate > 0, !source.isEmpty else { return [] }
    let targetFrames = max(1, Int((Double(source.count) * targetRate / sourceRate).rounded()))
    let step = sourceRate / targetRate
    return (0..<targetFrames).map { index in
      let position = Double(index) * step
      let left = min(Int(position), source.count - 1)
      let right = min(left + 1, source.count - 1)
      let fraction = Float(position - Double(left))
      let value = source[left] * (1 - fraction) + source[right] * fraction
      return Int16(max(-1, min(1, value)) * Float(Int16.max))
    }
  }

  private static func int16(_ buffer: AVAudioPCMBuffer) -> [Int16] {
    let count = Int(buffer.frameLength)
    guard count > 0, let floats = buffer.floatChannelData?[0] else { return [] }
    return (0..<count).map { index in
      Int16(max(-1, min(1, floats[index])) * Float(Int16.max))
    }
  }
}

/// Bluetooth headset mics are quiet. Built-in and USB inputs are not boosted.
final class HeadsetMicGain: @unchecked Sendable {
  private let lock = NSLock()
  private var gain = 1.0
  private var logged = false

  func reset() {
    lock.lock()
    gain = 1
    logged = false
    lock.unlock()
  }

  func process(_ samples: [Int16]) -> [Int16] {
    guard !samples.isEmpty else { return samples }
    let peak = samples.map { abs(Int32($0)) }.max() ?? 0
    lock.lock()
    var target = 1.0
    if peak >= 48, peak < 10_000 {
      target = min(16, 8_000 / Double(peak))
    }
    gain = target > gain ? (0.7 * gain + 0.3 * target) : (0.9 * gain + 0.1 * target)
    let apply = gain
    let shouldLog = !logged && apply > 1.2
    if shouldLog { logged = true }
    lock.unlock()
    if shouldLog {
      CaptureLog.line("headset mic gain=\(String(format: "%.1f", apply)) peak=\(peak)")
    }
    guard apply > 1.05 else { return samples }
    return samples.map { Int16(clamping: Int32((Double($0) * apply).rounded())) }
  }
}
