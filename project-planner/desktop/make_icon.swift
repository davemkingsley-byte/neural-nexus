// make_icon.swift — render the ProjectDesk app icon to a PNG.
// Usage: swift make_icon.swift <out.png> <size>
import Cocoa

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "icon_1024.png"
let size = CGFloat(args.count > 2 ? Int(args[2]) ?? 1024 : 1024)

let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let s = size
let inset = s * 0.086
let rect = NSRect(x: inset, y: inset, width: s - 2*inset, height: s - 2*inset)
let bg = NSBezierPath(roundedRect: rect, xRadius: s*0.19, yRadius: s*0.19)
NSGradient(colors: [NSColor(calibratedRed: 0.20, green: 0.40, blue: 0.92, alpha: 1),
                    NSColor(calibratedRed: 0.16, green: 0.28, blue: 0.62, alpha: 1)])?.draw(in: bg, angle: -90)

let bars: [(CGFloat, CGFloat, CGFloat, NSColor)] = [
    (0.235, 0.30, 0.44, NSColor.white.withAlphaComponent(0.95)),
    (0.335, 0.24, 0.40, NSColor(calibratedRed: 1, green: 0.82, blue: 0.35, alpha: 0.95)),
    (0.435, 0.32, 0.28, NSColor.white.withAlphaComponent(0.85)),
    (0.535, 0.22, 0.34, NSColor(calibratedRed: 0.55, green: 0.85, blue: 1, alpha: 0.95))
]
let barH = s * 0.066
for (y, x, w, c) in bars {
    c.setFill()
    NSBezierPath(roundedRect: NSRect(x: x*s, y: s - y*s - barH, width: w*s, height: barH),
                 xRadius: barH*0.35, yRadius: barH*0.35).fill()
}
img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("icon render failed\n".data(using: .utf8)!)
    exit(1)
}
try? png.write(to: URL(fileURLWithPath: out))
