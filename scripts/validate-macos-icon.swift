// macOS-only: inspect the icon embedded in the final .app with ImageIO/CoreGraphics.
// A byte-for-byte comparison cannot detect a malformed or unreadable ICNS image.
import Foundation
import ImageIO
import CoreGraphics

guard CommandLine.arguments.count == 2 else {
  fatalError("Usage: swift validate-macos-icon.swift path/to/icon.icns")
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
  fatalError("ImageIO could not open bundled .icns")
}
var largest: CGImage?
for index in 0..<CGImageSourceGetCount(source) {
  if let image = CGImageSourceCreateImageAtIndex(source, index, nil),
     image.width > (largest?.width ?? 0) {
    largest = image
  }
}
guard let image = largest, image.width >= 1024, image.height >= 1024 else {
  fatalError("macOS ICNS is missing a decodable 1024x1024 representation")
}
let width = 256, height = 256
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
  guard let ctx = CGContext(
    data: bytes.baseAddress,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
  ) else { return false }
  ctx.interpolationQuality = .high
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return true
}
guard rendered else { fatalError("CoreGraphics failed to render the ICNS") }
var orangePixels = 0, darkPixels = 0
for index in stride(from: 0, to: pixels.count, by: 4) {
  let r = Int(pixels[index]), g = Int(pixels[index+1])
  let b = Int(pixels[index+2]), a = Int(pixels[index+3])
  if a >= 160 && r >= 170 && g >= 70 && g <= 195 && b <= 85 && r > g { orangePixels += 1 }
  if a >= 160 && r <= 60 && g <= 60 && b <= 60 { darkPixels += 1 }
}
guard orangePixels >= 1000 && darkPixels >= 1000 else {
  fatalError("ICNS decoded but artwork is not the expected orange V on a dark background: orange=\(orangePixels), dark=\(darkPixels)")
}
print("Mac ICNS native render PASS: \(image.width)x\(image.height), orange=\(orangePixels), dark=\(darkPixels)")
