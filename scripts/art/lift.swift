// Lift a chickpea out of a render with Vision's subject lifting (macOS only).
// Usage: swiftc -O lift.swift -o lift && ./lift <in.png> <out.png> [--all]
// Picks the foreground instance under the image's lower-center point (the pea),
// never the arch behind it, or every instance with --all (a pose and its
// props), and writes a full-size PNG with a soft alpha matte.
import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

let all = CommandLine.arguments.contains("--all")
let args = CommandLine.arguments.filter { $0 != "--all" }
guard args.count == 3 else { FileHandle.standardError.write("usage: lift in out [--all]\n".data(using: .utf8)!); exit(2) }
let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("cannot read \(input.path)") }

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([request])
guard let result = request.results?.first else { fatalError("no subject found in \(input.path)") }

// The instance mask labels each pixel with its instance (0 = background).
let labels = result.instanceMask
CVPixelBufferLockBaseAddress(labels, .readOnly)
let w = CVPixelBufferGetWidth(labels), h = CVPixelBufferGetHeight(labels)
let row = CVPixelBufferGetBytesPerRow(labels)
let base = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
// Sample the lower-middle of the frame, where the pea's body always is.
var picked = IndexSet()
for (fx, fy) in [(0.5, 0.62), (0.5, 0.7), (0.45, 0.66), (0.55, 0.66)] {
  let label = base[Int(fy * Double(h)) * row + Int(fx * Double(w))]
  if label != 0 { picked.insert(Int(label)) }
}
CVPixelBufferUnlockBaseAddress(labels, .readOnly)
if all || picked.isEmpty { picked = result.allInstances }
FileHandle.standardError.write("\(input.lastPathComponent): instances \(result.allInstances.map { $0 }), picked \(picked.map { $0 })\n".data(using: .utf8)!)

let masked = try result.generateMaskedImage(ofInstances: picked, from: handler, croppedToInstancesExtent: false)
let ci = CIImage(cvPixelBuffer: masked)
let context = CIContext()
guard let outCG = context.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else { fatalError("render failed") }
guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("cannot write") }
CGImageDestinationAddImage(dest, outCG, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("write failed") }
