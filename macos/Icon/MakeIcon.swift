import AppKit

/// Draws the app icon and writes every size macOS asks for.
///
/// The mark is the thing the app exists to show: three usage meters, filling
/// from calm to spent. It reads as a mark at 1024 and still resolves into three
/// distinct bars at 32, which a more literal picture of a seat would not.
enum Icon {
	static let calm = NSColor(srgbRed: 0.35, green: 0.78, blue: 0.55, alpha: 1)
	static let warm = NSColor(srgbRed: 0.87, green: 0.72, blue: 0.35, alpha: 1)
	static let hot = NSColor(srgbRed: 0.91, green: 0.45, blue: 0.30, alpha: 1)

	/// Proportions are fractions of the canvas so every size is the same drawing,
	/// rather than a large one resampled down into mush.
	static func draw(size: CGFloat, in context: CGContext) {
		let rect = CGRect(x: 0, y: 0, width: size, height: size)
		context.saveGState()

		// macOS leaves a margin around an icon's artwork; matching it keeps this
		// the same visual weight as every other icon in the Dock.
		let inset = size * 0.08
		let plate = rect.insetBy(dx: inset, dy: inset)
		let corner = plate.width * 0.235

		let squircle = CGPath(
			roundedRect: plate, cornerWidth: corner, cornerHeight: corner, transform: nil)
		context.addPath(squircle)
		context.clip()

		let backdrop = CGGradient(
			colorsSpace: CGColorSpaceCreateDeviceRGB(),
			colors: [
				NSColor(srgbRed: 0.16, green: 0.18, blue: 0.24, alpha: 1).cgColor,
				NSColor(srgbRed: 0.09, green: 0.10, blue: 0.14, alpha: 1).cgColor,
			] as CFArray,
			locations: [0, 1])
		if let backdrop {
			context.drawLinearGradient(
				backdrop, start: CGPoint(x: 0, y: plate.maxY), end: CGPoint(x: 0, y: plate.minY),
				options: [])
		}

		// Three meters, each filled further than the last.
		let bars: [(fill: CGFloat, color: NSColor)] = [
			(0.42, calm), (0.68, warm), (0.93, hot),
		]
		let barHeight = plate.height * 0.093
		let gap = plate.height * 0.088
		let trackWidth = plate.width * 0.62
		let left = plate.minX + (plate.width - trackWidth) / 2
		let block = CGFloat(bars.count) * barHeight + CGFloat(bars.count - 1) * gap
		var y = plate.midY + block / 2 - barHeight

		for bar in bars {
			let track = CGRect(x: left, y: y, width: trackWidth, height: barHeight)
			context.addPath(
				CGPath(
					roundedRect: track, cornerWidth: barHeight / 2, cornerHeight: barHeight / 2,
					transform: nil))
			context.setFillColor(NSColor(white: 1, alpha: 0.13).cgColor)
			context.fillPath()

			let filled = CGRect(
				x: left, y: y, width: max(barHeight, trackWidth * bar.fill), height: barHeight)
			context.addPath(
				CGPath(
					roundedRect: filled, cornerWidth: barHeight / 2, cornerHeight: barHeight / 2,
					transform: nil))
			context.setFillColor(bar.color.cgColor)
			context.fillPath()

			y -= barHeight + gap
		}

		// A hairline along the top edge, which is what keeps the plate from
		// reading as flat against a dark Dock.
		context.addPath(squircle)
		context.setStrokeColor(NSColor(white: 1, alpha: 0.10).cgColor)
		context.setLineWidth(max(1, size * 0.004))
		context.strokePath()

		context.restoreGState()
	}

	static func png(size: Int) -> Data? {
		guard
			let context = CGContext(
				data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
				space: CGColorSpaceCreateDeviceRGB(),
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
		else { return nil }
		draw(size: CGFloat(size), in: context)
		guard let image = context.makeImage() else { return nil }
		let rep = NSBitmapImageRep(cgImage: image)
		return rep.representation(using: .png, properties: [:])
	}
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
// The sizes an .iconset must contain, named the way iconutil expects.
let wanted: [(name: String, pixels: Int)] = [
	("icon_16x16", 16), ("icon_16x16@2x", 32),
	("icon_32x32", 32), ("icon_32x32@2x", 64),
	("icon_128x128", 128), ("icon_128x128@2x", 256),
	("icon_256x256", 256), ("icon_256x256@2x", 512),
	("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

try FileManager.default.createDirectory(
	atPath: out, withIntermediateDirectories: true)

for entry in wanted {
	guard let data = Icon.png(size: entry.pixels) else {
		FileHandle.standardError.write("could not draw \(entry.name)\n".data(using: .utf8)!)
		exit(1)
	}
	try data.write(to: URL(fileURLWithPath: "\(out)/\(entry.name).png"))
}

// A standalone copy for the README and anywhere else the mark is needed.
if let data = Icon.png(size: 512) {
	try data.write(to: URL(fileURLWithPath: "\(out)/../icon.png"))
}

print("wrote \(wanted.count) sizes to \(out)")
