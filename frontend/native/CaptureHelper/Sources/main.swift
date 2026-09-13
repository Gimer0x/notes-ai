import AppKit
import Foundation

struct Inbound: Decodable {
  let id: String
  let cmd: String
}

struct Outbound: Encodable {
  let id: String
  let ok: Bool
  var error: String? = nil
  var systemAudioEnabled: Bool? = nil
  var filePath: String? = nil
  var micFilePath: String? = nil
  var systemFilePath: String? = nil
  var durationSeconds: Double? = nil
  var state: String? = nil
  var inputName: String? = nil
}

struct LevelsEvent: Encodable {
  let event = "levels"
  let mic: Double
  let system: Double
}

struct DeviceEvent: Encodable {
  let event = "device"
  let inputName: String
  let lost: Bool
}

let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)

let engine = CaptureEngine()
engine.onLevels = { mic, system in
  writeLevels(mic: mic, system: system)
}
engine.onDevice = { name, lost in
  writeDevice(inputName: name, lost: lost)
}
let encoder = JSONEncoder()
let decoder = JSONDecoder()
var leftover = Data()
let stdin = FileHandle.standardInput
let stdoutLock = NSLock()

func writeStdout(_ data: Data) {
  stdoutLock.lock()
  FileHandle.standardOutput.write(data)
  stdoutLock.unlock()
}

func writeOutbound(_ outbound: Outbound) {
  guard let data = try? encoder.encode(outbound),
        var line = String(data: data, encoding: .utf8)
  else { return }
  line.append("\n")
  writeStdout(Data(line.utf8))
}

func writeLevels(mic: Double, system: Double) {
  let event = LevelsEvent(
    mic: (mic * 1000).rounded() / 1000,
    system: (system * 1000).rounded() / 1000
  )
  guard let data = try? encoder.encode(event),
        var line = String(data: data, encoding: .utf8)
  else { return }
  line.append("\n")
  writeStdout(Data(line.utf8))
}

func writeDevice(inputName: String, lost: Bool) {
  let event = DeviceEvent(inputName: inputName, lost: lost)
  guard let data = try? encoder.encode(event),
        var line = String(data: data, encoding: .utf8)
  else { return }
  line.append("\n")
  writeStdout(Data(line.utf8))
}

func fail(_ inbound: Inbound, _ error: Error) {
  let code = (error as? CaptureError)?.rawValue ?? error.localizedDescription
  writeOutbound(Outbound(id: inbound.id, ok: false, error: code))
}

stdin.readabilityHandler = { handle in
  let chunk = handle.availableData
  if chunk.isEmpty {
    exit(0)
  }
  leftover.append(chunk)
  while let range = leftover.range(of: Data("\n".utf8)) {
    let line = leftover.subdata(in: leftover.startIndex..<range.lowerBound)
    leftover.removeSubrange(leftover.startIndex..<range.upperBound)
    guard let inbound = try? decoder.decode(Inbound.self, from: line) else {
      continue
    }
    Task {
      do {
        switch inbound.cmd {
        case "preview":
          let result = try await engine.preview()
          writeOutbound(
            Outbound(
              id: inbound.id,
              ok: true,
              systemAudioEnabled: result.systemAudioEnabled,
              inputName: result.inputName
            )
          )
        case "start":
          let result = try await engine.start()
          writeOutbound(
            Outbound(
              id: inbound.id,
              ok: true,
              systemAudioEnabled: result.systemAudioEnabled,
              inputName: result.inputName
            )
          )
        case "pause":
          try engine.pause()
          writeOutbound(Outbound(id: inbound.id, ok: true))
        case "resume":
          try engine.resume()
          writeOutbound(Outbound(id: inbound.id, ok: true))
        case "stop":
          let result = try await engine.stop()
          writeOutbound(
            Outbound(
              id: inbound.id,
              ok: true,
              systemAudioEnabled: result.systemAudioEnabled,
              filePath: result.url.path,
              micFilePath: result.micURL?.path,
              systemFilePath: result.systemURL?.path,
              durationSeconds: result.duration
            )
          )
        case "cancel":
          await engine.cancel()
          writeOutbound(Outbound(id: inbound.id, ok: true))
        case "state":
          writeOutbound(Outbound(id: inbound.id, ok: true, state: engine.currentState()))
        default:
          writeOutbound(Outbound(id: inbound.id, ok: false, error: "unknown_cmd"))
        }
      } catch {
        fail(inbound, error)
      }
    }
  }
}

nsApp.run()
