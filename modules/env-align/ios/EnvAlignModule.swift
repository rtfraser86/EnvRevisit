import CoreImage
import ExpoModulesCore
import UIKit
import Vision
import simd

/// Repeat-photo registration using Apple's Vision framework.
///
/// `align(refUri, movUri, outUri, outLong)` warps the moving photo onto the reference photo's
/// view with a homography from VNHomographicImageRegistrationRequest, and writes a JPEG the
/// same size as the reference (long side ≤ outLong). Never throws: returns ["ok": false, ...]
/// with a reason instead, so the JS side can mark the photo as "couldn't align".
public class EnvAlignModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EnvAlign")

    AsyncFunction("align") { (refUri: String, movUri: String, outUri: String, outLong: Double) -> [String: Any] in
      return EnvAligner.align(refUri: refUri, movUri: movUri, outUri: outUri, outLong: CGFloat(outLong))
    }
  }
}

enum EnvAligner {
  static let workLong: CGFloat = 1024
  static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  static func fail(_ reason: String) -> [String: Any] {
    return ["ok": false, "reason": reason]
  }

  static func path(from uri: String) -> String {
    if uri.hasPrefix("file://"), let u = URL(string: uri) { return u.path }
    return uri
  }

  /// Loads the image upright (EXIF orientation applied) and redraws it at exactly `size` px.
  static func load(_ uri: String) -> UIImage? {
    return UIImage(contentsOfFile: path(from: uri))
  }

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
    return CGSize(width: (s.width * k).rounded(), height: (s.height * k).rounded())
  }

  /// Apply a 3×3 homography (column-major simd) to a point.
  static func apply(_ m: simd_float3x3, _ p: CGPoint) -> CGPoint {
    let v = m * simd_float3(Float(p.x), Float(p.y), 1)
    return CGPoint(x: CGFloat(v.x / v.z), y: CGFloat(v.y / v.z))
  }

  /// Conjugate a homography found at one scale to another: H' = S·H·S⁻¹.
  static func rescale(_ m: simd_float3x3, by k: CGFloat) -> simd_float3x3 {
    let kf = Float(k)
    let s = simd_float3x3(diagonal: simd_float3(kf, kf, 1))
    let si = simd_float3x3(diagonal: simd_float3(1 / kf, 1 / kf, 1))
    return s * m * si
  }

  /// Warp `image` (CoreImage coordinates, origin bottom-left) with homography `m`,
  /// cropped to `size` and composited over black.
  static func warp(_ image: CIImage, _ m: simd_float3x3, size: CGSize) -> CIImage? {
    let w = size.width
    let h = size.height
    guard let f = CIFilter(name: "CIPerspectiveTransform") else { return nil }
    f.setValue(image, forKey: kCIInputImageKey)
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: 0, y: h))), forKey: "inputTopLeft")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: w, y: h))), forKey: "inputTopRight")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: 0, y: 0))), forKey: "inputBottomLeft")
    f.setValue(CIVector(cgPoint: apply(m, CGPoint(x: w, y: 0))), forKey: "inputBottomRight")
    guard let out = f.outputImage else { return nil }
    let rect = CGRect(origin: .zero, size: size)
    let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: rect)
    return out.cropped(to: rect).composited(over: black)
  }

  /// Mean absolute difference (0–1) between two same-sized images.
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
    // simd is column-major: m[col][row]
    return [
      Double(m[0][0]), Double(m[1][0]), Double(m[2][0]),
      Double(m[0][1]), Double(m[1][1]), Double(m[2][1]),
      Double(m[0][2]), Double(m[1][2]), Double(m[2][2]),
    ]
  }

  static func align(refUri: String, movUri: String, outUri: String, outLong: CGFloat) -> [String: Any] {
    guard let refImg = load(refUri) else { return fail("Could not read the reference photo") }
    guard let movImg = load(movUri) else { return fail("Could not read the photo") }

    let refAspect = refImg.size.width / refImg.size.height
    let movAspect = movImg.size.width / movImg.size.height
    if abs(refAspect - movAspect) > 0.12 * refAspect {
      return fail("Different shape from the reference (portrait vs landscape or a different crop)")
    }

    // Work at ~1024 px: both images at the reference's working size.
    let workSize = fit(refImg.size, long: workLong)
    guard let refWork = render(refImg, size: workSize), let movWork = render(movImg, size: workSize) else {
      return fail("Could not prepare the photos")
    }

    let request = VNHomographicImageRegistrationRequest(targetedCGImage: movWork, options: [:])
    let handler = VNImageRequestHandler(cgImage: refWork, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return fail("Registration failed: \(error.localizedDescription)")
    }
    guard let obs = request.results?.first as? VNImageHomographicAlignmentObservation else {
      return fail("No alignment found")
    }
    let hFound = obs.warpTransform

    // Vision's convention (which image the transform maps onto which) isn't spelled out, so
    // try both directions and keep whichever makes the warped photo match the reference best.
    let refCI = CIImage(cgImage: refWork)
    let movCI = CIImage(cgImage: movWork)
    let baseline = meanDiff(movCI, refCI, size: workSize)
    var best: (m: simd_float3x3, score: Double)? = nil
    for cand in [hFound, hFound.inverse] {
      guard let w = warp(movCI, cand, size: workSize) else { continue }
      let s = meanDiff(w, refCI, size: workSize)
      if best == nil || s < best!.score { best = (cand, s) }
    }
    guard let chosen = best else { return fail("Could not apply the alignment") }

    // Full-size output at the reference's output size.
    let outSize = fit(refImg.size, long: outLong)
    guard let movOut = render(movImg, size: outSize) else { return fail("Could not prepare the output") }
    let k = outSize.width / workSize.width
    let hOut = rescale(chosen.m, by: k)
    guard let warped = warp(CIImage(cgImage: movOut), hOut, size: outSize),
          let cg = ciContext.createCGImage(warped, from: CGRect(origin: .zero, size: outSize)),
          let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else {
      return fail("Could not render the aligned photo")
    }
    let outPath = path(from: outUri)
    do {
      try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: outPath).deletingLastPathComponent(), withIntermediateDirectories: true)
      try jpeg.write(to: URL(fileURLWithPath: outPath), options: .atomic)
    } catch {
      return fail("Could not save the aligned photo: \(error.localizedDescription)")
    }

    return [
      "ok": true,
      "uri": outUri,
      "width": Double(outSize.width),
      "height": Double(outSize.height),
      "h": rowMajor(chosen.m), // working-size pixels, CoreImage coords (origin bottom-left)
      "diffBefore": baseline,
      "diffAfter": chosen.score,
    ]
  }
}
