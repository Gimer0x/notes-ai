import AVFoundation
import CoreMedia

enum AudioConvert {
  static let floatMono16k = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(WavWriter.sampleRate),
    channels: AVAudioChannelCount(WavWriter.channels),
    interleaved: false
  )!

  static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      return nil
    }
    var asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)!.pointee
    guard let format = AVAudioFormat(streamDescription: &asbd) else {
      return nil
    }
    let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frames > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
    else {
      return nil
    }
    buffer.frameLength = frames
    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer,
      at: 0,
      frameCount: Int32(frames),
      into: buffer.mutableAudioBufferList
    )
    guard status == noErr else {
      return nil
    }
    return buffer
  }

  static func int16Mono16k(
    _ buffer: AVAudioPCMBuffer,
    converterCache: inout [String: AVAudioConverter]
  ) -> [Int16] {
    guard buffer.format.sampleRate > 0, buffer.format.channelCount > 0, buffer.frameLength > 0 else {
      return []
    }

    let key = buffer.format.settings.description
    let converter: AVAudioConverter
    if let cached = converterCache[key] {
      converter = cached
    } else if let created = AVAudioConverter(from: buffer.format, to: floatMono16k) {
      converterCache[key] = created
      converter = created
    } else {
      return []
    }

    converter.reset()

    let ratio = floatMono16k.sampleRate / buffer.format.sampleRate
    let outFrames = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up) + 32)
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
      return buffer
    }
    if error != nil {
      return []
    }

    let count = Int(output.frameLength)
    guard count > 0, let floats = output.floatChannelData?[0] else {
      return []
    }
    var samples = [Int16](repeating: 0, count: count)
    for index in 0..<count {
      let clipped = max(-1.0, min(1.0, floats[index]))
      samples[index] = Int16(clipped * Float(Int16.max))
    }
    return samples
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
}
