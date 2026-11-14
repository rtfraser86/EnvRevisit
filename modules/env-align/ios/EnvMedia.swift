import AVFoundation
import CoreImage
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Exports: change map, zip, time-lapse video / GIF. None of these throw; they return
/// ["ok": false, "reason": …] instead.
enum EnvMedia {
  static func fail(_ reason: String) -> [String: Any] {
    return ["ok": false, "reason": reason]
  }

  // MARK: - Change map

  /// Compares two photos that are already aligned and writes a PNG that is white where they
  /// differ, with alpha = how strongly. Overall brightness differences are evened out first and
  /// black borders (areas a warped photo doesn't cover) are ignored.
  static func changeMap(aUri: String, bUri: String, outUri: String, long: CGFloat, mask: [[Double]] = []) -> [String: Any] {
    guard let aImg = EnvAligner.load(aUri) else { return fail("Could not read the first photo") }
    guard let bImg = EnvAligner.load(bUri) else { return fail("Could not read the second photo") }
    let size = EnvAligner.fit(aImg.size, long: long)
    guard let aCG = EnvAligner.render(aImg, size: size), let bCG = EnvAligner.render(bImg, size: size) else {
      return fail("Could not prepare the photos")
    }
    let rect = CGRect(origin: .zero, size: size)
    let aRaw = CIImage(cgImage: aCG)
    let bRaw = CIImage(cgImage: bCG)

    func gray(_ image: CIImage, brightness: Double) -> CIImage {
      return image
        .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0, kCIInputBrightnessKey: brightness])
        .clampedToExtent()
        .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 2.5])
        .cropped(to: rect)
    }
    // 1 where the photo has content, 0 where it is pure black (outside a warped photo), shrunk
    // a little so the blurred border doesn't show up as change.
    func coverage(_ image: CIImage) -> CIImage {
      let k: CGFloat = 40
      return image
        .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0])
        .applyingFilter("CIColorMatrix", parameters: [
          "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0),
          "inputGVector": CIVector(x: 0, y: k, z: 0, w: 0),
          "inputBVector": CIVector(x: 0, y: 0, z: k, w: 0),
        ])
        .applyingFilter("CIColorClamp")
        .applyingFilter("CIMorphologyMinimum", parameters: [kCIInputRadiusKey: 6.0])
        .cropped(to: rect)
    }

    // Even out exposure: shift B's brightness to A's mean.
    let meanA = mean(gray(aRaw, brightness: 0), rect: rect)
    let meanB = mean(gray(bRaw, brightness: 0), rect: rect)
    let a = gray(aRaw, brightness: 0)
    let b = gray(bRaw, brightness: max(-0.5, min(0.5, meanA - meanB)))

    // Where change is measured: both photos have content and the user hasn't masked it out.
    var valid = coverage(aRaw).applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: coverage(bRaw)])
    if !mask.isEmpty {
      var keep = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: rect)
      for r in mask where r.count == 4 {
        // Fractions with origin top-left → CoreImage pixels with origin bottom-left.
        let w = CGFloat(r[2]) * size.width
        let h = CGFloat(r[3]) * size.height
        let x = CGFloat(r[0]) * size.width
        let y = size.height - CGFloat(r[1]) * size.height - h
        let hole = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: CGRect(x: x, y: y, width: w, height: h))
        keep = hole.composited(over: keep).cropped(to: rect)
      }
      valid = valid.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: keep]).cropped(to: rect)
    }
    var diff = a.applyingFilter("CIDifferenceBlendMode", parameters: [kCIInputBackgroundImageKey: b]).cropped(to: rect)
    diff = diff.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: valid]).cropped(to: rect)
    // Ignore small differences (noise, slight misalignment) and stretch the rest: (d − 0.07) × 5.
    let gain: CGFloat = 5
    let bias: CGFloat = -0.35
    diff = diff
      .applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: gain, y: 0, z: 0, w: 0),
        "inputGVector": CIVector(x: 0, y: gain, z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: gain, w: 0),
        "inputBiasVector": CIVector(x: bias, y: bias, z: bias, w: 0),
      ])
      .applyingFilter("CIColorClamp")
      .cropped(to: rect)

    // Share of the compared area (not of the whole frame) that changed.
    let changed = min(1, mean(diff, rect: rect) / max(0.01, mean(valid, rect: rect)))
    let map = diff.applyingFilter("CIMaskToAlpha").cropped(to: rect)
    guard let png = EnvAligner.ciContext.pngRepresentation(
      of: map, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]) else {
      return fail("Could not render the change map")
    }
    if let saveErr = EnvAligner.write(png, to: outUri) { return fail(saveErr) }
    return ["ok": true, "uri": outUri, "width": Double(size.width), "height": Double(size.height), "changed": changed]
  }

  /// Mean luminance (0–1) of an image over a rect.
  static func mean(_ image: CIImage, rect: CGRect) -> Double {
    let avg = image.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: rect)])
    var buf = [UInt8](repeating: 0, count: 4)
    EnvAligner.ciContext.render(avg, toBitmap: &buf, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                                format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    return (Double(buf[0]) + Double(buf[1]) + Double(buf[2])) / (3 * 255)
  }

  // MARK: - Zip

  /// Zips a folder using the system's file coordinator (no third-party code).
  static func zipFolder(dirUri: String, outUri: String) -> [String: Any] {
    let src = URL(fileURLWithPath: EnvAligner.path(from: dirUri))
    let dst = URL(fileURLWithPath: EnvAligner.path(from: outUri))
    var coordError: NSError?
    var result: [String: Any] = fail("Could not create the zip")
    NSFileCoordinator().coordinate(readingItemAt: src, options: [.forUploading], error: &coordError) { zipURL in
      do {
        let fm = FileManager.default
        try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
        try fm.copyItem(at: zipURL, to: dst)
        result = ["ok": true, "uri": outUri]
      } catch {
        result = fail("Could not save the zip: \(error.localizedDescription)")
      }
    }
    if let e = coordError { return fail("Could not create the zip: \(e.localizedDescription)") }
    return result
  }

  // MARK: - Time-lapse

  /// One frame: the photo fitted on black, with its label in a box at the top-left.
  static func drawFrame(_ img: UIImage, size: CGSize, label: String) -> CGImage? {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let out = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
      UIColor.black.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      let k = min(size.width / img.size.width, size.height / img.size.height)
      let w = img.size.width * k
      let h = img.size.height * k
      img.draw(in: CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h))
      if !label.isEmpty {
        let fs = max(14, min(size.width, size.height) * 0.045)
        let pad = fs * 0.4
        let attrs: [NSAttributedString.Key: Any] = [
          .font: UIFont.boldSystemFont(ofSize: fs),
          .foregroundColor: UIColor.white,
        ]
        let text = NSString(string: label)
        let bounds = text.boundingRect(
          with: CGSize(width: size.width - 4 * pad, height: size.height),
          options: [.usesLineFragmentOrigin], attributes: attrs, context: nil)
        let box = CGRect(x: pad, y: pad, width: ceil(bounds.width) + 2 * pad, height: ceil(bounds.height) + 2 * pad)
        UIColor(white: 0, alpha: 0.6).setFill()
        UIBezierPath(roundedRect: box, cornerRadius: pad).fill()
        text.draw(with: box.insetBy(dx: pad, dy: pad), options: [.usesLineFragmentOrigin], attributes: attrs, context: nil)
      }
    }
    return out.cgImage
  }

  static func timelapse(frames: [String], labels: [String], outUri: String, format: String,
                        long: CGFloat, seconds: Double) -> [String: Any] {
    guard !frames.isEmpty else { return fail("No photos to export") }
    guard let first = EnvAligner.load(frames[0]) else { return fail("Could not read the first photo") }
    // H.264 needs even dimensions.
    let fitted = EnvAligner.fit(first.size, long: long)
    let size = CGSize(width: max(2, floor(fitted.width / 2) * 2), height: max(2, floor(fitted.height / 2) * 2))
    let hold = max(0.1, seconds)

    let outURL = URL(fileURLWithPath: EnvAligner.path(from: outUri))
    let fm = FileManager.default
    try? fm.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if fm.fileExists(atPath: outURL.path) { try? fm.removeItem(at: outURL) }

    func frame(_ i: Int) -> CGImage? {
      guard let img = EnvAligner.load(frames[i]) else { return nil }
      return drawFrame(img, size: size, label: i < labels.count ? labels[i] : "")
    }

    let written: Int
    if format == "gif" {
      var images: [CGImage] = []
      for i in 0..<frames.count {
        autoreleasepool {
          if let cg = frame(i) { images.append(cg) }
        }
      }
      guard !images.isEmpty else { return fail("Could not read the photos") }
      guard let dest = CGImageDestinationCreateWithURL(
        outURL as CFURL, UTType.gif.identifier as CFString, images.count, nil) else {
        return fail("Could not create the GIF")
      }
      let fileProps: [String: Any] = [kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFLoopCount as String: 0]]
      CGImageDestinationSetProperties(dest, fileProps as CFDictionary)
      let frameProps: [String: Any] = [
        kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFDelayTime as String: hold]
      ]
      for cg in images {
        CGImageDestinationAddImage(dest, cg, frameProps as CFDictionary)
      }
      guard CGImageDestinationFinalize(dest) else { return fail("Could not write the GIF") }
      written = images.count
    } else {
      let writer: AVAssetWriter
      do {
        writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
      } catch {
        return fail("Could not create the video: \(error.localizedDescription)")
      }
      let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(size.width),
        AVVideoHeightKey: Int(size.height),
      ]
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
      input.expectsMediaDataInRealTime = false
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: Int(size.width),
        kCVPixelBufferHeightKey as String: Int(size.height),
      ])
      guard writer.canAdd(input) else { return fail("Could not set up the video") }
      writer.add(input)
      guard writer.startWriting() else {
        return fail("Could not start the video: \(writer.error?.localizedDescription ?? "unknown error")")
      }
      writer.startSession(atSourceTime: .zero)

      let scale: Int32 = 600
      func time(_ secondsFromStart: Double) -> CMTime {
        return CMTime(value: CMTimeValue((secondsFromStart * Double(scale)).rounded()), timescale: scale)
      }
      func waitUntilReady() -> Bool {
        var tries = 0
        while !input.isReadyForMoreMediaData && tries < 1000 {
          Thread.sleep(forTimeInterval: 0.01)
          tries += 1
        }
        return input.isReadyForMoreMediaData
      }

      var count = 0
      var lastBuffer: CVPixelBuffer?
      for i in 0..<frames.count {
        autoreleasepool {
          guard let cg = frame(i), let buffer = pixelBuffer(from: cg, size: size), waitUntilReady() else { return }
          if adaptor.append(buffer, withPresentationTime: time(Double(count) * hold)) {
            count += 1
            lastBuffer = buffer
          }
        }
      }
      guard count > 0 else {
        writer.cancelWriting()
        return fail("Could not read the photos")
      }
      // Repeat the last photo just before the end so it is held as long as the others.
      let end = Double(count) * hold
      if let last = lastBuffer, waitUntilReady() {
        _ = adaptor.append(last, withPresentationTime: time(end - 1.0 / 30.0))
      }
      input.markAsFinished()
      writer.endSession(atSourceTime: time(end))
      let done = DispatchSemaphore(value: 0)
      writer.finishWriting { done.signal() }
      done.wait()
      guard writer.status == .completed else {
        return fail("Could not finish the video: \(writer.error?.localizedDescription ?? "unknown error")")
      }
      written = count
    }

    return ["ok": true, "uri": outUri, "frames": written, "width": Double(size.width), "height": Double(size.height)]
  }

  static func pixelBuffer(from cg: CGImage, size: CGSize) -> CVPixelBuffer? {
    var made: CVPixelBuffer?
    let attrs: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, attrs as CFDictionary, &made)
    guard status == kCVReturnSuccess, let buffer = made else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer),
      width: Int(size.width),
      height: Int(size.height),
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
      return nil
    }
    ctx.draw(cg, in: CGRect(origin: .zero, size: size))
    return buffer
  }
}
