import AVFoundation

enum AudioConvert {
  static let floatMono16k = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(WavWriter.sampleRate),
    channels: AVAudioChannelCount(WavWriter.channels),
    interleaved: false
  )!

  static func int16Mono16k(
    _ buffer: AVAudioPCMBuffer,
    converterCache: inout [String: AVAudioConverter]
  ) -> [Int16] {
    guard buffer.format.sampleRate > 0, buffer.format.channelCount > 0, buffer.frameLength > 0 else {
      return []
    }
    guard let mono = mixdownMonoKeepRate(buffer) else {
      return []
    }
    if abs(mono.format.sampleRate - floatMono16k.sampleRate) < 1 {
      return floatToInt16(mono)
    }

    let key = "sr=\(mono.format.sampleRate)"
    let converter: AVAudioConverter
    if let cached = converterCache[key] {
      converter = cached
    } else if let created = AVAudioConverter(from: mono.format, to: floatMono16k) {
      converterCache[key] = created
      converter = created
    } else {
      return []
    }

    converter.reset()

    let ratio = floatMono16k.sampleRate / mono.format.sampleRate
    let outFrames = AVAudioFrameCount((Double(mono.frameLength) * ratio).rounded(.up) + 32)
    guard let output = AVAudioPCMBuffer(pcmFormat: floatMono16k, frameCapacity: outFrames) else {
      return []
    }

    var error: NSError?
    var consumed = false
    converter.convert(to: output, error: &error) { _, outStatus in
      if consumed {
        outStatus.pointee = .endOfStream
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return mono
    }
    if error != nil {
      return []
    }
    return floatToInt16(output)
  }

  /// Average every channel so a 3-mic Mac array is not collapsed to a silent channel.
  static func mixdownMonoKeepRate(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard frames > 0, channels > 0 else { return nil }
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: buffer.format.sampleRate,
      channels: 1,
      interleaved: false
    ),
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
      let dst = output.floatChannelData?[0]
    else {
      return nil
    }
    output.frameLength = AVAudioFrameCount(frames)
    guard writeMonoFloat(from: buffer, into: dst, frames: frames, channels: channels) else {
      return nil
    }
    return output
  }

  /// 0...1 RMS of Int16 PCM. Near-silence is 0 so the UI does not fake motion.
  static func displayLevel(_ samples: [Int16]) -> Double {
    guard !samples.isEmpty else { return 0 }
    var sum = 0.0
    for sample in samples {
      let normalized = Double(sample) / 32768.0
      sum += normalized * normalized
    }
    let rms = sqrt(sum / Double(samples.count))
    if rms < 0.004 {
      return 0
    }
    return min(1, (rms - 0.004) * 14)
  }

  static func mix(_ mic: [Int16], _ system: [Int16]) -> [Int16] {
    let count = max(mic.count, system.count)
    guard count > 0 else { return [] }
    var mixed = [Int16](repeating: 0, count: count)
    for index in 0..<count {
      let a = index < mic.count ? Int32(mic[index]) : 0
      let b = index < system.count ? Int32(system[index]) : 0
      mixed[index] = Int16(clamping: a + b)
    }
    return mixed
  }

  private static func floatToInt16(_ buffer: AVAudioPCMBuffer) -> [Int16] {
    let count = Int(buffer.frameLength)
    guard count > 0, let floats = buffer.floatChannelData?[0] else {
      return []
    }
    var samples = [Int16](repeating: 0, count: count)
    for index in 0..<count {
      let clipped = max(-1.0, min(1.0, floats[index]))
      samples[index] = Int16(clipped * Float(Int16.max))
    }
    return samples
  }

  private static func writeMonoFloat(
    from buffer: AVAudioPCMBuffer,
    into dst: UnsafeMutablePointer<Float>,
    frames: Int,
    channels: Int
  ) -> Bool {
    let scale = 1.0 / Float(channels)
    if let floats = buffer.floatChannelData {
      if buffer.format.isInterleaved {
        for frame in 0..<frames {
          var sum: Float = 0
          for channel in 0..<channels {
            sum += floats[0][frame * channels + channel]
          }
          dst[frame] = sum * scale
        }
      } else {
        for frame in 0..<frames {
          var sum: Float = 0
          for channel in 0..<channels {
            sum += floats[channel][frame]
          }
          dst[frame] = sum * scale
        }
      }
      return true
    }
    if let ints = buffer.int16ChannelData {
      if buffer.format.isInterleaved {
        for frame in 0..<frames {
          var sum: Float = 0
          for channel in 0..<channels {
            sum += Float(ints[0][frame * channels + channel]) / 32768.0
          }
          dst[frame] = sum * scale
        }
      } else {
        for frame in 0..<frames {
          var sum: Float = 0
          for channel in 0..<channels {
            sum += Float(ints[channel][frame]) / 32768.0
          }
          dst[frame] = sum * scale
        }
      }
      return true
    }

    let list = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    guard list.count > 0, let data = list[0].mData else {
      return false
    }
    let asbd = buffer.format.streamDescription.pointee
    if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
      let src = data.assumingMemoryBound(to: Float.self)
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channels {
          sum += src[frame * channels + channel]
        }
        dst[frame] = sum * scale
      }
      return true
    }
    if asbd.mBitsPerChannel == 16 {
      let src = data.assumingMemoryBound(to: Int16.self)
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channels {
          sum += Float(src[frame * channels + channel]) / 32768.0
        }
        dst[frame] = sum * scale
      }
      return true
    }
    return false
  }
}
