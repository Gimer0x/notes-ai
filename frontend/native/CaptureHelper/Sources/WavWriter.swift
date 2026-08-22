import Foundation

enum WavWriterError: Error {
  case empty
}

enum WavWriter {
  static let sampleRate = 16_000
  static let channels = 1
  static let bitsPerSample = 16

  static func writeCanonical(samples: [Int16], to url: URL) throws {
    guard !samples.isEmpty else { throw WavWriterError.empty }

    let dataSize = samples.count * MemoryLayout<Int16>.size
    let pad = dataSize % 2
    let riffSize = 4 + 8 + 16 + 8 + dataSize + pad

    var data = Data()
    data.append(contentsOf: [UInt8]("RIFF".utf8))
    data.append(uint32: UInt32(riffSize))
    data.append(contentsOf: [UInt8]("WAVE".utf8))
    data.append(contentsOf: [UInt8]("fmt ".utf8))
    data.append(uint32: 16)
    data.append(uint16: 1)
    data.append(uint16: UInt16(channels))
    data.append(uint32: UInt32(sampleRate))
    let byteRate = sampleRate * channels * bitsPerSample / 8
    data.append(uint32: UInt32(byteRate))
    data.append(uint16: UInt16(channels * bitsPerSample / 8))
    data.append(uint16: UInt16(bitsPerSample))
    data.append(contentsOf: [UInt8]("data".utf8))
    data.append(uint32: UInt32(dataSize))
    data.append(samples.withUnsafeBytes { Data($0) })
    if pad == 1 {
      data.append(0)
    }

    try data.write(to: url, options: .atomic)
    fputs("wrote wav bytes=\(data.count) samples=\(samples.count) path=\(url.path)\n", stderr)
  }
}

private extension Data {
  mutating func append(uint16 value: UInt16) {
    var value = value.littleEndian
    Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
  }

  mutating func append(uint32 value: UInt32) {
    var value = value.littleEndian
    Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
  }
}
