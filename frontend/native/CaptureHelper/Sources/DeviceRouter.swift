import Foundation

/// Watches default input and output UIDs. A sample-rate change on the same UID is ignored.
final class DeviceRouter: DeviceRouting, @unchecked Sendable {
  var onRouteChange: ((RouteChange) -> Void)?

  private let queue = DispatchQueue(label: "dev.pith.device-router")
  private var cancelObserve: (() -> Void)?
  private var debounce: DispatchWorkItem?
  private var poll: DispatchSourceTimer?
  private var last = DeviceSnapshot()
  private var suppressUntil = Date.distantPast
  private var started = false

  func start() {
    queue.sync {
      guard !started else { return }
      started = true
      last = AudioDevices.snapshot()
      CaptureLog.line(
        "device router start in=\(last.input?.summary ?? "none") out=\(last.output?.summary ?? "none")"
      )
      cancelObserve = AudioDevices.observe(queue) { [weak self] in self?.schedule() }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 2, repeating: 2)
      timer.setEventHandler { [weak self] in self?.emitIfChanged() }
      timer.resume()
      poll = timer
    }
  }

  func stop() {
    queue.sync {
      started = false
      debounce?.cancel()
      debounce = nil
      poll?.cancel()
      poll = nil
      cancelObserve?()
      cancelObserve = nil
    }
  }

  func rememberCurrent() {
    queue.sync { last = AudioDevices.snapshot() }
  }

  func suppress(for seconds: TimeInterval) {
    queue.async { [weak self] in
      guard let self else { return }
      let until = Date().addingTimeInterval(seconds)
      if until > self.suppressUntil {
        self.suppressUntil = until
      }
    }
  }

  private func schedule() {
    debounce?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.emitIfChanged() }
    debounce = work
    queue.asyncAfter(deadline: .now() + 0.6, execute: work)
  }

  private func emitIfChanged() {
    guard started, Date() >= suppressUntil else { return }
    let next = AudioDevices.snapshot()
    let change = RouteChange(previous: last, next: next)
    guard change.inputChanged || change.outputChanged || change.inputFormatChanged || change.outputFormatChanged else {
      return
    }
    last = next
    log(change)
    onRouteChange?(change)
  }

  private func log(_ change: RouteChange) {
    if change.inputChanged {
      let wasBT = change.previous.input?.isBluetooth == true
      let nowBT = change.next.input?.isBluetooth == true
      if !wasBT, nowBT {
        CaptureLog.line("bluetooth input connected \(change.next.input?.summary ?? "none")")
      } else if wasBT, !nowBT {
        CaptureLog.line("bluetooth input disconnected now=\(change.next.input?.summary ?? "none")")
      } else {
        CaptureLog.line(
          "input changed \(change.previous.input?.summary ?? "none") -> \(change.next.input?.summary ?? "none")"
        )
      }
    } else if change.inputFormatChanged {
      CaptureLog.line(
        "input format \(change.previous.input?.summary ?? "none") -> \(change.next.input?.summary ?? "none")"
      )
    }
    if change.outputChanged {
      let wasBT = change.previous.output?.isBluetooth == true
      let nowBT = change.next.output?.isBluetooth == true
      if !wasBT, nowBT {
        CaptureLog.line("bluetooth output connected \(change.next.output?.summary ?? "none")")
      } else if wasBT, !nowBT {
        CaptureLog.line("bluetooth output disconnected now=\(change.next.output?.summary ?? "none")")
      } else {
        CaptureLog.line(
          "output changed \(change.previous.output?.summary ?? "none") -> \(change.next.output?.summary ?? "none")"
        )
      }
    } else if change.outputFormatChanged {
      CaptureLog.line(
        "output format \(change.previous.output?.summary ?? "none") -> \(change.next.output?.summary ?? "none")"
      )
    }
  }
}
