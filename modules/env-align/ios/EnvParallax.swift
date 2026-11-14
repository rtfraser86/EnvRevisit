import CoreImage
import simd
import UIKit
import Vision

/// Parallax between a near band (bottom of the frame) and a far band (top of the frame).
///
/// Turning the phone shifts everything in the picture by the same amount; stepping sideways or
/// forwards shifts nearby ground much more than distant background. Registering the two bands
/// separately and taking the difference separates the step from the turn. The JS side turns the
/// difference into metres using the camera's tilt and an assumed phone height.
enum EnvParallax {
  /// Bands as (top, bottom) fractions of the height, origin top-left.
  static let far: (CGFloat, CGFloat) = (0.06, 0.38)
  static let near: (CGFloat, CGFloat) = (0.62, 0.94)

  /// Returns shifts to apply to `mov` so each band lines up with `ref`, as fractions of the frame
  /// (x right, y down), or nil fields for a band without enough detail.
  ///
  /// `m` is the frame's whole-picture match (moving → reference, CoreImage coords). Its rotation is
  /// taken out first: a tilted phone moves the top and bottom bands in opposite directions, which
  /// would otherwise look like a sideways step. (Parallax doesn't show up in that rotation: stepping
  /// sideways shifts rows by different amounts, it doesn't turn the picture.)
  static func bands(ref: UIImage, mov: UIImage, m match: simd_float3x3, long: CGFloat = 480) -> [String: Any] {
    let size = EnvAligner.fit(ref.size, long: long)
    guard let r = EnvAligner.render(ref, size: size), let raw = EnvAligner.render(mov, size: size) else {
      return [:]
    }
    let theta = CGFloat(atan2(Double(match[0][1]), Double(match[0][0])))
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let turn = CGAffineTransform(translationX: c.x, y: c.y).rotated(by: theta).translatedBy(x: -c.x, y: -c.y)
    let rect = CGRect(origin: .zero, size: size)
    let straightened = CIImage(cgImage: raw).transformed(by: turn).cropped(to: rect)
    guard let m = EnvAligner.ciContext.createCGImage(straightened, from: rect) else { return [:] }
    var out: [String: Any] = [
      "farY": Double((far.0 + far.1) / 2),
      "nearY": Double((near.0 + near.1) / 2),
    ]
    if let s = shift(r, m, size: size, band: far) {
      out["farDx"] = s.dx
      out["farDy"] = s.dy
    }
    if let s = shift(r, m, size: size, band: near) {
      out["nearDx"] = s.dx
      out["nearDy"] = s.dy
    }
    return out
  }

  private static func shift(_ ref: CGImage, _ mov: CGImage, size: CGSize,
                            band: (CGFloat, CGFloat)) -> (dx: Double, dy: Double)? {
    // CGImage cropping uses a top-left origin.
    let marginX = (size.width * 0.06).rounded()
    let crop = CGRect(x: marginX, y: (size.height * band.0).rounded(),
                      width: size.width - 2 * marginX, height: (size.height * (band.1 - band.0)).rounded())
    guard crop.width > 16, crop.height > 16,
          let rc = ref.cropping(to: crop), let mc = mov.cropping(to: crop) else { return nil }

    let request = VNTranslationalImageRegistrationRequest(targetedCGImage: mc, options: [:])
    let handler = VNImageRequestHandler(cgImage: rc, options: [:])
    do { try handler.perform([request]) } catch { return nil }
    guard let obs = request.results?.first as? VNImageTranslationAlignmentObservation else { return nil }
    let tx = Double(obs.alignmentTransform.tx)
    let ty = Double(obs.alignmentTransform.ty)

    // Vision doesn't say which way round the translation goes, so try each reading on the
    // band itself and keep the one that matches best. Shifts here are CoreImage (y up).
    let refCI = CIImage(cgImage: rc)
    let movCI = CIImage(cgImage: mc)
    let w = crop.width
    let h = crop.height
    let limit = max(abs(tx), abs(ty))
    guard limit < Double(min(w, h)) * 0.45 else { return nil }
    let inset = CGRect(x: 0, y: 0, width: w, height: h).insetBy(dx: CGFloat(limit) + 2, dy: CGFloat(limit) + 2)
    guard inset.width > 8, inset.height > 8 else { return nil }
    func score(_ cx: Double, _ cy: Double) -> Double {
      let moved = movCI.transformed(by: CGAffineTransform(translationX: CGFloat(cx), y: CGFloat(cy)))
      let diff = moved.applyingFilter("CIDifferenceBlendMode", parameters: [kCIInputBackgroundImageKey: refCI])
      return EnvMedia.mean(diff, rect: inset)
    }
    let zero = score(0, 0)
    var best: (cx: Double, cy: Double, s: Double) = (0, 0, zero)
    for (cx, cy) in [(tx, ty), (-tx, -ty), (tx, -ty), (-tx, ty)] {
      let s = score(cx, cy)
      if s < best.s { best = (cx, cy, s) }
    }
    // A shift that barely helps means the band has too little detail (sky, water, blur).
    if (best.cx != 0 || best.cy != 0) && best.s > zero * 0.97 { return nil }
    return (dx: best.cx / Double(size.width), dy: -best.cy / Double(size.height))
  }
}
