import AppKit

/// Draws the app icon and writes every size macOS asks for.
///
/// The mark is three slabs stacked in an isometric view on a light porcelain
/// plate: two of white porcelain and, on top, one of frosted indigo glass, the
/// account in use. The light plate keeps the icon standing out in dark mode.
enum Icon {
	static let plateTop = NSColor(srgbRed: 0.99, green: 0.99, blue: 1.00, alpha: 1)
	static let plateBottom = NSColor(srgbRed: 0.92, green: 0.925, blue: 0.945, alpha: 1)

	/// The colours of one slab: its top face, top to bottom, and its edge, top
	/// to bottom, with the colour of the shadow it casts on what is below it.
	struct Material {
		let face: (NSColor, NSColor)
		let edge: (NSColor, NSColor)
		let shadow: NSColor
		let glow: NSColor?
	}

	static let porcelain = Material(
		face: (
			NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
			NSColor(srgbRed: 0.965, green: 0.967, blue: 0.978, alpha: 1)
		),
		edge: (
			NSColor(srgbRed: 0.85, green: 0.86, blue: 0.89, alpha: 1),
			NSColor(srgbRed: 0.73, green: 0.74, blue: 0.79, alpha: 1)
		),
		shadow: NSColor(srgbRed: 0.25, green: 0.27, blue: 0.42, alpha: 0.26),
		glow: nil)

	static let glass = Material(
		face: (
			NSColor(srgbRed: 0.85, green: 0.86, blue: 0.99, alpha: 1),
			NSColor(srgbRed: 0.66, green: 0.68, blue: 0.97, alpha: 1)
		),
		edge: (
			NSColor(srgbRed: 0.56, green: 0.58, blue: 0.93, alpha: 1),
			NSColor(srgbRed: 0.72, green: 0.74, blue: 0.98, alpha: 1)
		),
		shadow: NSColor(srgbRed: 0.36, green: 0.36, blue: 0.92, alpha: 0.34),
		glow: NSColor(srgbRed: 0.50, green: 0.52, blue: 0.97, alpha: 0.45))

	static let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

	/// Proportions are fractions of the canvas so every size is the same drawing,
	/// rather than a large one resampled down into mush.
	///
	/// `framed` draws the icon as macOS shows it, with the margin and shadow
	/// every Dock icon has. Unframed, the plate fills the canvas and the slabs
	/// are larger and thicker, for places that draw it at 12 to 16 points and
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
				color: NSColor(white: 0, alpha: 0.28).cgColor)
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

		let width = plate.width * (framed ? 0.70 : 0.80)
		let thickness = max(plate.width * (framed ? 0.034 : 0.05), 1)
		let spacing = plate.width * (framed ? 0.14 : 0.16)
		let middle = plate.midY + thickness / 2
		let layers: [(y: CGFloat, material: Material)] = [
			(middle - spacing, porcelain), (middle, porcelain), (middle + spacing, glass),
		]
		for layer in layers {
			slab(
				center: CGPoint(x: plate.midX, y: layer.y), width: width, thickness: thickness,
				material: layer.material, size: size, in: context)
		}

		// A hairline along the edge, which keeps the light plate from melting
		// into a light window behind it.
		context.addPath(squircle)
		context.setStrokeColor(NSColor(white: 0, alpha: 0.07).cgColor)
		context.setLineWidth(max(1, size * 0.004))
		context.strokePath()

		context.restoreGState()
	}

	/// One slab: a rounded square seen from above at an isometric angle, with
	/// `thickness` of edge showing below its top face.
	static func slab(
		center: CGPoint, width: CGFloat, thickness: CGFloat, material: Material, size: CGFloat,
		in context: CGContext
	) {
		let side = width / 2.squareRoot()
		var toView = CGAffineTransform(translationX: center.x, y: center.y)
			.scaledBy(x: 1, y: 0.55)
			.rotated(by: .pi / 4)
			.translatedBy(x: -side / 2, y: -side / 2)
		let face = CGPath(
			roundedRect: CGRect(x: 0, y: 0, width: side, height: side),
			cornerWidth: side * 0.14, cornerHeight: side * 0.14, transform: &toView)
		let bounds = face.boundingBoxOfPath

		// The face swept straight down by the thickness: the face itself, the
		// face lowered, and the band between their left and right corners.
		var lower = CGAffineTransform(translationX: 0, y: -thickness)
		let band = CGPath(
			rect: CGRect(x: bounds.minX, y: center.y - thickness, width: bounds.width, height: thickness),
			transform: nil)
		let solid = face.union(face.copy(using: &lower) ?? face).union(band)

		context.saveGState()
		context.setShadow(
			offset: CGSize(width: 0, height: -size * 0.016), blur: size * 0.04,
			color: material.shadow.cgColor)
		context.addPath(solid)
		context.setFillColor(material.edge.1.cgColor)
		context.fillPath()
		context.restoreGState()

		context.saveGState()
		context.addPath(solid)
		context.clip()
		if let edge = gradient(material.edge.0, material.edge.1) {
			context.drawLinearGradient(
				edge, start: CGPoint(x: 0, y: center.y), end: CGPoint(x: 0, y: bounds.minY - thickness),
				options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
		}
		context.restoreGState()

		context.saveGState()
		context.addPath(face)
		context.clip()
		if let top = gradient(material.face.0, material.face.1) {
			context.drawLinearGradient(
				top, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: 0, y: bounds.minY),
				options: [])
		}
		if let glow = material.glow, let light = gradient(glow, glow.withAlphaComponent(0)) {
			let source = CGPoint(x: center.x, y: center.y - bounds.height * 0.12)
			context.drawRadialGradient(
				light, startCenter: source, startRadius: 0, endCenter: source,
				endRadius: bounds.width * 0.45, options: [])
		}
		context.addPath(face)
		context.setStrokeColor(NSColor(white: 1, alpha: 0.8).cgColor)
		context.setLineWidth(max(0.5, size * 0.004))
		context.strokePath()
		context.restoreGState()
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
