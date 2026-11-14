import AVFoundation
import CoreImage
import ImageIO
import QuartzCore
import UIKit
import simd

/// Live matching against the camera's video frames.
///
/// The camera itself belongs to expo-camera. Its preview layer exposes the capture session, so
/// this adds a video-frame output to that same session and keeps the most recent frame. Each
/// `match` call registers that frame against the ghost photo — several times a second, with no
/// still photos taken.
final class EnvLive: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  static let shared = EnvLive()

  private let frameQueue = DispatchQueue(label: "au.com.fraserws.envalign.frames")
  private let lock = NSLock()
  /// Serialises match() and stop(), which are called from background queues (never the main thread).
  private let stateLock = NSLock()
  private var latest: CVPixelBuffer?
  private var latestTime: CFTimeInterval = 0
  private var output: AVCaptureVideoDataOutput?
  private weak var session: AVCaptureSession?
  private var refUri = ""
  private var refImage: UIImage?
  /// Which way round frames need turning for each way of holding the phone, once confirmed.
  private var orientationFor: [String: CGImagePropertyOrientation] = [:]

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lock.lock()
    latest = buffer
    latestTime = CACurrentMediaTime()
    lock.unlock()
  }

  // MARK: - Finding the camera

  private static func search(_ view: UIView) -> AVCaptureSession? {
    if let preview = view.layer as? AVCaptureVideoPreviewLayer, let s = preview.session, view.window != nil {
      return s
    }
    for sub in view.subviews {
      if let s = search(sub) { return s }
    }
    return nil
  }

  private func findSession() -> AVCaptureSession? {
    var found: AVCaptureSession?
    let work = {
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        for window in windowScene.windows {
          if let s = EnvLive.search(window) {
            found = s
            return
          }
        }
      }
    }
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.sync(execute: work)
    }
    return found
  }

  private func ensureAttached() -> Bool {
    if let s = session, let o = output, s.isRunning, s.outputs.contains(o) { return true }
    guard let s = findSession(), s.isRunning else { return false }
    detach()
    let o = AVCaptureVideoDataOutput()
    o.alwaysDiscardsLateVideoFrames = true
    o.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
    o.setSampleBufferDelegate(self, queue: frameQueue)
    s.beginConfiguration()
    let canAdd = s.canAddOutput(o)
    if canAdd { s.addOutput(o) }
    s.commitConfiguration()
    guard canAdd else { return false }
    session = s
    output = o
    return true
  }

  private func detach() {
    if let s = session, let o = output, s.outputs.contains(o) {
      s.beginConfiguration()
      s.removeOutput(o)
      s.commitConfiguration()
    }
    output?.setSampleBufferDelegate(nil, queue: nil)
    output = nil
    session = nil
    lock.lock()
    latest = nil
    lock.unlock()
  }

  /// expo-camera sets videoZoomFactor = min · (max / min)^zoom, where min is 1 for a single lens and
  /// the wide lens's switch-over factor on a virtual multi-lens camera.
  func zoomRange() -> [String: Any] {
    guard let s = findSession() else { return ["ok": false, "reason": "no-camera"] }
    var device: AVCaptureDevice?
    for input in s.inputs {
      if let d = input as? AVCaptureDeviceInput, d.device.hasMediaType(.video) {
        device = d.device
        break
      }
    }
    guard let d = device else { return ["ok": false, "reason": "no-camera"] }
    var minFactor: CGFloat = 1
    if d.constituentDevices.contains(where: { $0.deviceType == .builtInUltraWideCamera }),
       let first = d.virtualDeviceSwitchOverVideoZoomFactors.first {
      minFactor = CGFloat(truncating: first)
    }
    return [
      "ok": true,
      "min": Double(minFactor),
      "max": Double(d.activeFormat.videoMaxZoomFactor),
      "device": d.deviceType.rawValue,
    ]
  }

  func stop() {
    stateLock.lock()
    defer { stateLock.unlock() }
    detach()
    refImage = nil
    refUri = ""
    orientationFor = [:]
  }

  // MARK: - Matching

  /// The frame turned upright, cropped to the reference's shape (what the user sees in the
  /// camera box) and scaled down for matching.
  private func prepared(_ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                        aspect: CGFloat, long: CGFloat) -> UIImage? {
    var image = CIImage(cvPixelBuffer: buffer).oriented(orientation)
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
    let w = image.extent.width
    let h = image.extent.height
    guard w > 1, h > 1, aspect > 0 else { return nil }
    var crop = CGRect(x: 0, y: 0, width: w, height: h)
    if w / h > aspect {
      let cw = h * aspect
      crop = CGRect(x: (w - cw) / 2, y: 0, width: cw, height: h)
    } else {
      let ch = w / aspect
      crop = CGRect(x: 0, y: (h - ch) / 2, width: w, height: ch)
    }
    image = image.cropped(to: crop)
      .transformed(by: CGAffineTransform(translationX: -crop.origin.x, y: -crop.origin.y))
    let k = min(1, long / max(crop.width, crop.height))
    image = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
    let rect = CGRect(x: 0, y: 0, width: (crop.width * k).rounded(.down), height: (crop.height * k).rounded(.down))
    guard rect.width > 1, rect.height > 1, let cg = EnvAligner.ciContext.createCGImage(image, from: rect) else {
      return nil
    }
    return UIImage(cgImage: cg)
  }

  func match(refUri: String, hold: String, workLong: CGFloat) -> [String: Any] {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard ensureAttached() else { return ["ok": false, "reason": "no-camera"] }
    lock.lock()
    let frame = latest
    let age = CACurrentMediaTime() - latestTime
    lock.unlock()
    guard let buffer = frame, age < 1.0 else { return ["ok": false, "reason": "no-frame"] }

    if refUri != self.refUri || refImage == nil {
      refImage = EnvAligner.load(refUri)
      self.refUri = refUri
      orientationFor = [:]
    }
    guard let ref = refImage, ref.size.width > 1, ref.size.height > 1 else {
      return ["ok": false, "reason": "Could not read the ghost photo"]
    }
    let aspect = ref.size.width / ref.size.height

    // Frames normally arrive sideways (sensor orientation). Work out which turn is right by
    // trying the two that give the right shape, then remember it.
    let bufferIsPortrait = CVPixelBufferGetWidth(buffer) < CVPixelBufferGetHeight(buffer)
    let wantPortrait = hold == "portrait"
    let candidates: [CGImagePropertyOrientation]
    if let known = orientationFor[hold] {
      candidates = [known]
    } else if bufferIsPortrait == wantPortrait {
      candidates = [.up, .down] // already the right shape: upright or upside down
    } else {
      candidates = [.right, .left] // a quarter turn one way or the other
    }

    var best: (est: Estimate, orientation: CGImagePropertyOrientation, mov: UIImage)?
    var scores: [Double] = []
    var reason = "No alignment found"
    for o in candidates {
      guard let mov = prepared(buffer, orientation: o, aspect: aspect, long: workLong) else { continue }
      let (est, err) = EnvAligner.estimate(ref, mov, workLong: workLong)
      guard let e = est else {
        if let err = err { reason = err }
        continue
      }
      // A repeat photo is never rotated far from the original; a large rotation means the
      // frame is the wrong way up for this candidate.
      let rotation = abs(atan2(Double(e.m[0][1]), Double(e.m[0][0]))) * 180 / Double.pi
      if rotation > 45 {
        reason = "No confident match"
        continue
      }
      scores.append(e.after)
      if best == nil || e.after < best!.est.after { best = (e, o, mov) }
    }
    guard let chosen = best else { return ["ok": false, "reason": reason] }

    // Remember the orientation once one candidate is clearly the better match.
    if orientationFor[hold] == nil && chosen.est.after < chosen.est.before * 0.85 {
      let others = scores.filter { $0 > chosen.est.after }
      if candidates.count == 1 || (others.first ?? 1) > chosen.est.after * 1.15 {
        orientationFor[hold] = chosen.orientation
      }
    }

    var result: [String: Any] = [
      "ok": true,
      "h": EnvAligner.rowMajor(chosen.est.m),
      "width": Double(chosen.est.workSize.width),
      "height": Double(chosen.est.workSize.height),
      "diffBefore": chosen.est.before,
      "diffAfter": chosen.est.after,
    ]
    // Near/far parallax for the step hints, only once the view is roughly lined up.
    if chosen.est.after < chosen.est.before {
      result["bands"] = EnvParallax.bands(ref: ref, mov: chosen.mov, m: chosen.est.m)
    }
    return result
  }
}
