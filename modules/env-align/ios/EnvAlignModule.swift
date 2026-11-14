import CoreImage
import ExpoModulesCore
import UIKit
import Vision
import simd

/// Repeat-photo registration using Apple's Vision framework.
///
/// - `align(refUri, movUri, outUri, outLong)` warps the moving photo onto the reference view and
///   writes a JPEG the size of the reference (long side ≤ outLong).
/// - `register(refUri, movUri, workLong)` only estimates the transform (used live, ~1×/s,
///   to guide the user onto the original framing).
/// - `edges(uri, outUri, long)` writes a PNG whose alpha is the photo's edges (for the outline ghost).
///
/// None of these throw: they return ["ok": false, "reason": …] instead.
public class EnvAlignModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EnvAlign")

    AsyncFunction("align") { (refUri: String, movUri: String, outUri: String, outLong: Double) -> [String: Any] in
      return EnvAligner.align(refUri: refUri, movUri: movUri, outUri: outUri, outLong: CGFloat(outLong))
    }

    AsyncFunction("register") { (refUri: String, movUri: String, workLong: Double) -> [String: Any] in
      return EnvAligner.register(refUri: refUri, movUri: movUri, workLong: CGFloat(workLong))
    }

    AsyncFunction("edges") { (uri: String, outUri: String, long: Double) -> [String: Any] in
      return EnvAligner.edges(uri: uri, outUri: outUri, long: CGFloat(long))
    }

    // Warp a photo with a transform worked out in JS (tie-point alignment).
    AsyncFunction("warp") { (movUri: String, outUri: String, h: [Double], outW: Double, outH: Double) -> [String: Any] in
      return EnvAligner.warpFile(movUri: movUri, outUri: outUri, h: h, outSize: CGSize(width: outW, height: outH))
    }

    // Where two aligned photos differ (white = changed, alpha = how much).
    AsyncFunction("changeMap") { (aUri: String, bUri: String, outUri: String, long: Double) -> [String: Any] in
      return EnvMedia.changeMap(aUri: aUri, bUri: bUri, outUri: outUri, long: CGFloat(long))
    }

    // Zip a folder (station export).
    AsyncFunction("zipFolder") { (dirUri: String, outUri: String) -> [String: Any] in
      return EnvMedia.zipFolder(dirUri: dirUri, outUri: outUri)
    }

    // Time-lapse: format is "mp4" or "gif"; one label per frame is burnt into the picture.
    AsyncFunction("timelapse") { (frames: [String], labels: [String], outUri: String, format: String, long: Double, seconds: Double) -> [String: Any] in
      return EnvMedia.timelapse(frames: frames, labels: labels, outUri: outUri, format: format, long: CGFloat(long), seconds: seconds)
    }

    // Live matching against the camera's video frames. hold is "portrait", "cw" or "ccw".
    AsyncFunction("liveMatch") { (refUri: String, hold: String, workLong: Double) -> [String: Any] in
      return EnvLive.shared.match(refUri: refUri, hold: hold, workLong: CGFloat(workLong))
    }

    AsyncFunction("liveStop") { () -> Bool in
      EnvLive.shared.stop()
      return true
    }

    // Change map that leaves out masked areas (rects: [x, y, w, h] as fractions, origin top-left).
    AsyncFunction("changeMapMasked") { (aUri: String, bUri: String, outUri: String, long: Double, rects: [[Double]]) -> [String: Any] in
      return EnvMedia.changeMap(aUri: aUri, bUri: bUri, outUri: outUri, long: CGFloat(long), mask: rects)
    }

    // The camera's zoom range, so in-between zoom levels can be set exactly.
    AsyncFunction("zoomRange") { () -> [String: Any] in
      return EnvLive.shared.zoomRange()
    }
  }
}

struct Estimate {
  let m: simd_float3x3 // maps moving-image pixels → reference pixels, CoreImage coords (origin bottom-left)
  let workSize: CGSize
  let before: Double
  let after: Double
}

enum EnvAligner {
  static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  static func fail(_ reason: String) -> [String: Any] {
    return ["ok": false, "reason": reason]
  }

  static func path(from uri: String) -> String {
    if uri.hasPrefix("file://"), let u = URL(string: uri) { return u.path }
    return uri
  }

  static func load(_ uri: String) -> UIImage? {
    return UIImage(contentsOfFile: path(from: uri))
  }

  /// Redraws upright (EXIF orientation applied) at exactly `size` px.
  static func render(_ img: UIImage, size: CGSize) -> CGImage? {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let out = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      img.draw(in: CGRect(origin: .zero, size: size))
    }
    return out.cgImage
  }

  static func fit(_ s: CGSize, long: CGFloat) -> CGSize {
    let k = min(1, long / max(s.width, s.height))
    return CGSize(width: max(1, (s.width * k).rounded()), height: max(1, (s.height * k).rounded()))
  }

  static func apply(_ m: simd_float3x3, _ p: CGPoint) -> CGPoint {
    let v = m * simd_float3(Float(p.x), Float(p.y), 1)
    return CGPoint(x: CGFloat(v.x / v.z), y: CGFloat(v.y / v.z))
  }

  /// H' = S·H·S⁻¹ for a uniform scale k.
  static func rescale(_ m: simd_float3x3, by k: CGFloat) -> simd_float3x3 {
    let kf = Float(k)
    let s = simd_float3x3(diagonal: simd_float3(kf, kf, 1))
    let si = simd_float3x3(diagonal: simd_float3(1 / kf, 1 / kf, 1))
    return s * m * si
  }

  /// Same transform expressed with the y axis flipped (top-left ↔ bottom-left origin).
  static func flipY(_ m: simd_float3x3, height: CGFloat) -> simd_float3x3 {
    let f = flipMatrix(height) // its own inverse
    return f * m * f
  }

  /// Flip between top-left and bottom-left origins for an image of the given height.
  static func flipMatrix(_ height: CGFloat) -> simd_float3x3 {
    return simd_float3x3(columns: (
      simd_float3(1, 0, 0),
      simd_float3(0, -1, 0),
      simd_float3(0, Float(height), 1)
    ))
  }

  /// Warp `image` (srcSize px, CoreImage coords) with `m` into an outSize frame, over black.
  static func warp(_ image: CIImage, _ m: simd_float3x3, srcSize: CGSize, outSize: CGSize) -> CIImage? {
    let w = srcSize.width
    let h = srcSize.height
    guard let f = CIFilter(name: "CIPerspectiveTransform") else { return nil }
    f.setValue(image, forKey: kCIInputImageKey)
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: 0, y: h))), forKey: "inputTopLeft")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: w, y: h))), forKey: "inputTopRight")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: 0, y: 0))), forKey: "inputBottomLeft")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: w, y: 0))), forKey: "inputBottomRight")
    guard let out = f.outputImage else { return nil }
    let rect = CGRect(origin: .zero, size: outSize)
    let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: rect)
    return out.cropped(to: rect).composited(over: black)
  }

  static func warp(_ image: CIImage, _ m: simd_float3x3, size: CGSize) -> CIImage? {
    return warp(image, m, srcSize: size, outSize: size)
  }

  /// Tie-point alignment: `h` is row-major and maps photo pixels to output pixels, both with
  /// the origin at the top-left.
  static func warpFile(movUri: String, outUri: String, h: [Double], outSize: CGSize) -> [String: Any] {
    guard h.count == 9, outSize.width >= 2, outSize.height >= 2 else { return fail("Bad transform") }
    guard let movImg = load(movUri) else { return fail("Could not read the photo") }
    let movSize = CGSize(width: movImg.size.width.rounded(), height: movImg.size.height.rounded())
    guard let movCG = render(movImg, size: movSize) else { return fail("Could not prepare the photo") }
    let top = simd_float3x3(rows: [
      simd_float3(Float(h[0]), Float(h[1]), Float(h[2])),
      simd_float3(Float(h[3]), Float(h[4]), Float(h[5])),
      simd_float3(Float(h[6]), Float(h[7]), Float(h[8])),
    ])
    // Into CoreImage coordinates (origin bottom-left) on both sides.
    let m = flipMatrix(outSize.height) * top * flipMatrix(movSize.height)
    let corners = [
      CGPoint(x: 0, y: 0), CGPoint(x: movSize.width, y: 0),
      CGPoint(x: 0, y: movSize.height), CGPoint(x: movSize.width, y: movSize.height),
    ]
    for c in corners {
      let v = m * simd_float3(Float(c.x), Float(c.y), 1)
      if !(v.z > 1e-6) { return fail("The markers give an impossible alignment") }
    }
    guard let warped = warp(CIImage(cgImage: movCG), m, srcSize: movSize, outSize: outSize),
          let cg = ciContext.createCGImage(warped, from: CGRect(origin: .zero, size: outSize)),
          let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else {
      return fail("Could not render the aligned photo")
    }
    if let saveErr = write(jpeg, to: outUri) { return fail(saveErr) }
    return ["ok": true, "uri": outUri, "width": Double(outSize.width), "height": Double(outSize.height)]
  }

  static func meanDiff(_ a: CIImage, _ b: CIImage, size: CGSize) -> Double {
    guard let d = CIFilter(name: "CIDifferenceBlendMode"),
          let avg = CIFilter(name: "CIAreaAverage") else { return 1 }
    d.setValue(a, forKey: kCIInputImageKey)
    d.setValue(b, forKey: kCIInputBackgroundImageKey)
    guard let diff = d.outputImage else { return 1 }
    avg.setValue(diff, forKey: kCIInputImageKey)
    avg.setValue(CIVector(cgRect: CGRect(origin: .zero, size: size)), forKey: kCIInputExtentKey)
    guard let px = avg.outputImage else { return 1 }
    var buf = [UInt8](repeating: 0, count: 4)
    ciContext.render(px, toBitmap: &buf, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                     format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    return (Double(buf[0]) + Double(buf[1]) + Double(buf[2])) / (3 * 255)
  }

  static func rowMajor(_ m: simd_float3x3) -> [Double] {
    return [
      Double(m[0][0]), Double(m[1][0]), Double(m[2][0]),
      Double(m[0][1]), Double(m[1][1]), Double(m[2][1]),
      Double(m[0][2]), Double(m[1][2]), Double(m[2][2]),
    ]
  }

  static func estimate(_ refImg: UIImage, _ movImg: UIImage, workLong: CGFloat) -> (Estimate?, String?) {
    let refAspect = refImg.size.width / refImg.size.height
    let movAspect = movImg.size.width / movImg.size.height
    if abs(refAspect - movAspect) > 0.12 * refAspect {
      return (nil, "Different shape from the reference (portrait vs landscape or a different crop)")
    }
    let workSize = fit(refImg.size, long: workLong)
    guard let refWork = render(refImg, size: workSize), let movWork = render(movImg, size: workSize) else {
      return (nil, "Could not prepare the photos")
    }
    let request = VNHomographicImageRegistrationRequest(targetedCGImage: movWork, options: [:])
    let handler = VNImageRequestHandler(cgImage: refWork, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return (nil, "Registration failed: \(error.localizedDescription)")
    }
    guard let obs = request.results?.first as? VNImageHomographicAlignmentObservation else {
      return (nil, "No alignment found")
    }
    let found = obs.warpTransform

    // Vision doesn't document which way round the transform goes or which corner is the
    // origin, so try all four readings and keep the one that best matches the reference.
    let refCI = CIImage(cgImage: refWork)
    let movCI = CIImage(cgImage: movWork)
    let before = meanDiff(movCI, refCI, size: workSize)
    let h = workSize.height
    let candidates = [found, found.inverse, flipY(found, height: h), flipY(found.inverse, height: h)]
    var best: (m: simd_float3x3, score: Double)? = nil
    for cand in candidates {
      guard let w = warp(movCI, cand, size: workSize) else { continue }
      let s = meanDiff(w, refCI, size: workSize)
      if best == nil || s < best!.score { best = (cand, s) }
    }
    guard let chosen = best else { return (nil, "Could not apply the alignment") }
    return (Estimate(m: chosen.m, workSize: workSize, before: before, after: chosen.score), nil)
  }

  static func register(refUri: String, movUri: String, workLong: CGFloat) -> [String: Any] {
    guard let refImg = load(refUri) else { return fail("Could not read the reference photo") }
    guard let movImg = load(movUri) else { return fail("Could not read the photo") }
    let (est, err) = estimate(refImg, movImg, workLong: workLong)
    guard let e = est else { return fail(err ?? "No alignment found") }
    return [
      "ok": true,
      "h": rowMajor(e.m),
      "width": Double(e.workSize.width),
      "height": Double(e.workSize.height),
      "diffBefore": e.before,
      "diffAfter": e.after,
    ]
  }

  static func align(refUri: String, movUri: String, outUri: String, outLong: CGFloat) -> [String: Any] {
    guard let refImg = load(refUri) else { return fail("Could not read the reference photo") }
    guard let movImg = load(movUri) else { return fail("Could not read the photo") }
    let (est, err) = estimate(refImg, movImg, workLong: 1024)
    guard let e = est else { return fail(err ?? "No alignment found") }

    let outSize = fit(refImg.size, long: outLong)
    guard let movOut = render(movImg, size: outSize) else { return fail("Could not prepare the output") }
    let hOut = rescale(e.m, by: outSize.width / e.workSize.width)
    guard let warped = warp(CIImage(cgImage: movOut), hOut, size: outSize),
          let cg = ciContext.createCGImage(warped, from: CGRect(origin: .zero, size: outSize)),
          let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else {
      return fail("Could not render the aligned photo")
    }
    if let saveErr = write(jpeg, to: outUri) { return fail(saveErr) }
    return [
      "ok": true,
      "uri": outUri,
      "width": Double(outSize.width),
      "height": Double(outSize.height),
      "h": rowMajor(e.m),
      "diffBefore": e.before,
      "diffAfter": e.after,
    ]
  }

  static func write(_ data: Data, to uri: String) -> String? {
    let p = path(from: uri)
    do {
      try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: p).deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: URL(fileURLWithPath: p), options: .atomic)
      return nil
    } catch {
      return "Could not save: \(error.localizedDescription)"
    }
  }

  /// White lines on transparent: alpha = edge strength. Tinted in the app.
  static func edges(uri: String, outUri: String, long: CGFloat) -> [String: Any] {
    guard let img = load(uri) else { return fail("Could not read the photo") }
    let size = fit(img.size, long: long)
    guard let cg = render(img, size: size) else { return fail("Could not prepare the photo") }
    let rect = CGRect(origin: .zero, size: size)
    var ci = CIImage(cgImage: cg)
      .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0])
    // A little blur first so grass and leaf texture doesn't turn into noise.
    ci = ci.clampedToExtent()
      .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 1.5])
      .cropped(to: rect)
    ci = ci.applyingFilter("CIEdges", parameters: [kCIInputIntensityKey: 6.0]).cropped(to: rect)
    ci = ci.applyingFilter("CIColorControls", parameters: [
      kCIInputSaturationKey: 0,
      kCIInputBrightnessKey: -0.08,
      kCIInputContrastKey: 1.8,
    ])
    ci = ci.applyingFilter("CIMaskToAlpha").cropped(to: rect)
    guard let png = ciContext.pngRepresentation(of: ci, format: .RGBA8,
                                                colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]) else {
      return fail("Could not render edges")
    }
    if let saveErr = write(png, to: outUri) { return fail(saveErr) }
    return ["ok": true, "uri": outUri, "width": Double(size.width), "height": Double(size.height)]
  }
}
