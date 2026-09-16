import AppKit

/// Each service's mark, drawn as a template so it takes the menu bar's own
/// colour like the text beside it. The files are SVGs in the bundle.
enum Logo {
	private static var cache: [String: NSImage] = [:]

	/// The file each service's mark lives in. Codex is an OpenAI product and
	/// has no mark of its own.
	static func fileName(for provider: String) -> String? {
		switch provider {
		case "claude": return "claude"
		case "codex": return "openai"
		default: return nil
		}
	}

	static func image(for provider: String, in directory: URL? = Bundle.main.resourceURL, height: CGFloat = 12)
		-> NSImage?
	{
		guard let name = fileName(for: provider), let directory else { return nil }
		let key = "\(name)@\(height)"
		if let cached = cache[key] { return cached }
		let url = directory.appendingPathComponent("\(name).svg")
		guard let image = NSImage(contentsOf: url), image.isValid, image.size.height > 0 else { return nil }
		let width = image.size.width / image.size.height * height
		image.size = NSSize(width: width, height: height)
		image.isTemplate = true
		cache[key] = image
		return image
	}

	/// The mark painted in one flat colour, resolved under the given appearance
	/// so it matches the text it sits beside on a light or a dark menu bar.
	static func tinted(_ image: NSImage, with color: NSColor, appearance: NSAppearance?) -> NSImage {
		let size = image.size
		let result = NSImage(size: size, flipped: false) { rect in
			var resolved = color
			(appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
				resolved = NSColor(cgColor: color.cgColor) ?? color
			}
			image.draw(in: rect)
			resolved.set()
			rect.fill(using: .sourceAtop)
			return true
		}
		result.isTemplate = false
		return result
	}
}
