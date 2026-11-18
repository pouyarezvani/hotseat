import AppKit

/// Draws the app icon and writes every size macOS asks for.
///
/// The mark is a white disc cut into two halves, the right half raised a step
/// above the left, on a graphite plate lit softly from above. The cut and the
/// step are never less than a pixel, so the two halves still separate at 16.
enum Icon {
	static let plateTop = NSColor(srgbRed: 0.31, green: 0.32, blue: 0.35, alpha: 1)
	static let plateBottom = NSColor(srgbRed: 0.11, green: 0.12, blue: 0.14, alpha: 1)
	static let markTop = NSColor(srgbRed: 0.99, green: 0.99, blue: 1.00, alpha: 1)
	static let markBottom = NSColor(srgbRed: 0.84, green: 0.85, blue: 0.87, alpha: 1)

	static let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

	/// Proportions are fractions of the canvas so every size is the same drawing,
	/// rather than a large one resampled down into mush.
	///
	/// `framed` draws the icon as macOS shows it, with the margin and shadow
	/// every Dock icon has. Unframed, the plate fills the canvas and the disc,
	/// cut and step are heavier, for places that draw it at 12 to 16 points and
	/// frame it themselves, such as a project list.
	static func draw(size: CGFloat, in context: CGContext, framed: Bool = true) {
		let rect = CGRect(x: 0, y: 0, width: size, height: size)

		// macOS leaves a margin around an icon's artwork; matching it keeps this
		// the same visual weight as every other icon in the Dock.
		let inset = framed ? size * 0.08 : 0
		let plate = rect.insetBy(dx: inset, dy: inset)
		let corner = plate.width * 0.235
		let squircle = CGPath(
			roundedRect: plate, cornerWidth: corner, cornerHeight: corner, transform: nil)

		if framed {
			context.saveGState()
			context.setShadow(
				offset: CGSize(width: 0, height: -size * 0.008), blur: size * 0.02,
				color: NSColor(white: 0, alpha: 0.35).cgColor)
			context.addPath(squircle)
			context.setFillColor(plateBottom.cgColor)
			context.fillPath()
			context.restoreGState()
		}

		context.saveGState()
		context.addPath(squircle)
		context.clip()

		if let backdrop = gradient(plateTop, plateBottom) {
			context.drawLinearGradient(
				backdrop, start: CGPoint(x: 0, y: plate.maxY), end: CGPoint(x: 0, y: plate.minY),
				options: [])
		}
		if let sheen = gradient(NSColor(white: 1, alpha: 0.10), NSColor(white: 1, alpha: 0)) {
			let source = CGPoint(x: plate.midX, y: plate.maxY + plate.height * 0.15)
			context.drawRadialGradient(
				sheen, startCenter: source, startRadius: 0, endCenter: source,
				endRadius: plate.width * 0.75, options: [])
		}

		let weight: CGFloat = framed ? 1 : 1.7
		let radius = plate.width * (framed ? 0.29 : 0.32)
		// The cut's edges land on whole pixels, so at small sizes it stays a
		// clean dark line instead of a grey smear.
		let cut = max(1, (plate.width * 0.026 * weight).rounded())
		let cutLeft = (plate.midX - cut / 2).rounded()
		let step = max(plate.width * 0.032 * weight, 1)
		let round = plate.width * 0.008
		let halves = [
			half(
				center: CGPoint(x: plate.midX, y: plate.midY - step / 2), radius: radius,
				cut: cutLeft, keepsLeft: true, round: round),
			half(
				center: CGPoint(x: plate.midX, y: plate.midY + step / 2), radius: radius,
				cut: cutLeft + cut, keepsLeft: false, round: round),
		]
		for shape in halves {
			context.saveGState()
			context.setShadow(
				offset: CGSize(width: 0, height: -size * 0.006), blur: size * 0.018,
				color: NSColor(white: 0, alpha: 0.5).cgColor)
			context.addPath(shape)
			context.setFillColor(markBottom.cgColor)
			context.fillPath()
			context.restoreGState()

			context.saveGState()
			context.addPath(shape)
			context.clip()
			let bounds = shape.boundingBoxOfPath
			if let face = gradient(markTop, markBottom) {
				context.drawLinearGradient(
					face, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: 0, y: bounds.minY),
					options: [])
			}
			context.restoreGState()
		}

		// A hairline along the edge, which is what keeps the plate from reading
		// as flat against a dark Dock.
		context.addPath(squircle)
		context.setStrokeColor(NSColor(white: 1, alpha: 0.10).cgColor)
		context.setLineWidth(max(1, size * 0.004))
		context.strokePath()

		context.restoreGState()
	}

	/// The part of a circle on one side of the vertical line at `cut`, with both
	/// corners of the cut rounded by `round`. The shape is drawn `round` smaller
	/// and then grown by a stroke of that width, which rounds the corners and
	/// nothing else.
	static func half(center: CGPoint, radius: CGFloat, cut: CGFloat, keepsLeft: Bool, round: CGFloat)
		-> CGPath
	{
		let inner = radius - round
		let offset = (keepsLeft ? cut - round : cut + round) - center.x
		let angle = acos(max(-1, min(1, offset / inner)))
		let path = CGMutablePath()
		if keepsLeft {
			path.addArc(
				center: center, radius: inner, startAngle: angle, endAngle: 2 * .pi - angle,
				clockwise: false)
		} else {
			path.addArc(
				center: center, radius: inner, startAngle: -angle, endAngle: angle, clockwise: false)
		}
		path.closeSubpath()
		guard round > 0 else { return path }
		return path.union(
			path.copy(strokingWithWidth: round * 2, lineCap: .round, lineJoin: .round, miterLimit: 10))
	}

	static func gradient(_ from: NSColor, _ to: NSColor) -> CGGradient? {
		CGGradient(colorsSpace: space, colors: [from.cgColor, to.cgColor] as CFArray, locations: [0, 1])
	}

	static func png(size: Int, framed: Bool = true) -> Data? {
		guard
			let context = CGContext(
				data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
				space: space,
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
		else { return nil }
		draw(size: CGFloat(size), in: context, framed: framed)
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

// The same mark without the macOS margin, for lists that draw a project's
// icon at 12 to 16 points.
if let data = Icon.png(size: 128, framed: false) {
	try data.write(to: URL(fileURLWithPath: "\(out)/../favicon.png"))
}

print("wrote \(wanted.count) sizes to \(out)")
