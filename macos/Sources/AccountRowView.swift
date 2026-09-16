import AppKit

/// One account in the menu: its name on top, a drawn meter per limit below.
///
/// The row is a container rather than a single drawing view because the
/// highlight is the system's selection material, which is a real view. A view
/// draws its own content first and its subviews after, so the material has to
/// sit under a separate content view or it paints over everything.
final class AccountRowView: NSView {
	private let content: RowContentView
	private let highlight: NSVisualEffectView

	static let horizontalInset: CGFloat = 5
	private static let lineHeight: CGFloat = 17
	private static let titleHeight: CGFloat = 20

	init(account: Account, isActive: Bool, width: CGFloat) {
		content = RowContentView(account: account, isActive: isActive)
		highlight = NSVisualEffectView()
		let lines = max(1, account.usage?.windows.count ?? 1)
		let height = Self.titleHeight + CGFloat(lines) * Self.lineHeight + 10
		super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))

		// The menu sizes itself to its widest item, which can exceed the width
		// passed in, so both layers track the row rather than a fixed size.
		autoresizingMask = [.width]

		highlight.material = .selection
		highlight.blendingMode = .behindWindow
		highlight.state = .active
		highlight.isEmphasized = true
		highlight.wantsLayer = true
		highlight.layer?.cornerRadius = 5
		highlight.frame = bounds.insetBy(dx: Self.horizontalInset, dy: 0)
		highlight.autoresizingMask = [.width, .height]
		highlight.isHidden = true
		addSubview(highlight)

		content.frame = bounds
		content.autoresizingMask = [.width, .height]
		addSubview(content)
	}

	required init?(coder: NSCoder) { nil }

	private func setHighlighted(_ value: Bool) {
		guard highlight.isHidden == value else { return }
		highlight.isHidden = !value
		content.isHighlighted = value
	}

	override func mouseEntered(with event: NSEvent) { setHighlighted(true) }
	override func mouseExited(with event: NSEvent) { setHighlighted(false) }

	override func updateTrackingAreas() {
		super.updateTrackingAreas()
		for area in trackingAreas { removeTrackingArea(area) }
		addTrackingArea(
			NSTrackingArea(
				rect: bounds,
				options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
				owner: self))
	}

	override func mouseUp(with event: NSEvent) {
		guard let item = enclosingMenuItem, let menu = item.menu else { return }
		menu.cancelTracking()
		if let action = item.action, let target = item.target {
			_ = (target as AnyObject).perform(action, with: item)
		}
	}
}

/// Draws the account's name and one meter per limit. Kept separate so it can sit
/// above the highlight material in the view order.
private final class RowContentView: NSView {
	private let account: Account
	private let isActive: Bool

	var isHighlighted = false {
		didSet { if isHighlighted != oldValue { needsDisplay = true } }
	}

	private static let rowInset: CGFloat = 14
	private static let barHeight: CGFloat = 5
	private static let barCorner: CGFloat = 2.5
	private static let meterWidth: CGFloat = 132
	private static let labelWidth: CGFloat = 44
	private static let valueWidth: CGFloat = 38
	private static let lineHeight: CGFloat = 17
	private static let titleHeight: CGFloat = 20

	init(account: Account, isActive: Bool) {
		self.account = account
		self.isActive = isActive
		super.init(frame: .zero)
	}

	required init?(coder: NSCoder) { nil }

	override func draw(_ dirtyRect: NSRect) {
		var y = bounds.maxY - Self.titleHeight
		drawTitle(at: y)
		y -= 2
		for window in account.usage?.windows ?? [] {
			y -= Self.lineHeight
			draw(window: window, atY: y)
		}
		if let error = account.usage?.error {
			y -= Self.lineHeight
			draw(
				text: error, at: NSPoint(x: Self.rowInset + 16, y: y + 2),
				font: .systemFont(ofSize: 11), color: tertiaryText)
		} else if account.usage?.windows.isEmpty ?? true {
			y -= Self.lineHeight
			draw(
				text: "no usage data yet", at: NSPoint(x: Self.rowInset + 16, y: y + 2),
				font: .systemFont(ofSize: 11), color: tertiaryText)
		}
	}

	private var primaryText: NSColor { isHighlighted ? .selectedMenuItemTextColor : .labelColor }
	private var secondaryText: NSColor {
		isHighlighted ? NSColor.selectedMenuItemTextColor.withAlphaComponent(0.8) : .secondaryLabelColor
	}
	private var tertiaryText: NSColor {
		isHighlighted
			? NSColor.selectedMenuItemTextColor.withAlphaComponent(0.65) : .tertiaryLabelColor
	}

	/// On the highlight the severity colours lose contrast against the selection,
	/// so the meter and its number take the selection's own foreground instead.
	private func severityColor(_ percent: Double) -> NSColor {
		isHighlighted ? .selectedMenuItemTextColor : Severity(percent: percent).color
	}

	private func drawTitle(at y: CGFloat) {
		let dot = isActive ? "\u{25CF}" : account.disabled ? "\u{2205}" : "\u{25CB}"
		let dotColor: NSColor = isActive ? severityColor(account.worstPercent) : tertiaryText
		draw(
			text: dot, at: NSPoint(x: Self.rowInset, y: y + 3), font: .systemFont(ofSize: 10),
			color: dotColor)
		let weight: NSFont.Weight = isActive ? .semibold : .regular
		draw(
			text: account.displayName,
			at: NSPoint(x: Self.rowInset + 16, y: y + 2),
			font: .systemFont(ofSize: 13, weight: weight),
			color: account.disabled ? tertiaryText : primaryText)
	}

	private func draw(window: UsageWindow, atY y: CGFloat) {
		let left = Self.rowInset + 16
		draw(
			text: window.label, at: NSPoint(x: left, y: y + 1), font: .systemFont(ofSize: 11),
			color: secondaryText)

		let track = NSRect(
			x: left + Self.labelWidth, y: y + 5, width: Self.meterWidth, height: Self.barHeight)
		(isHighlighted
			? NSColor.selectedMenuItemTextColor.withAlphaComponent(0.25)
			: NSColor.quaternaryLabelColor.withAlphaComponent(0.35)).setFill()
		NSBezierPath(roundedRect: track, xRadius: Self.barCorner, yRadius: Self.barCorner).fill()

		let fraction = min(max(window.percent, 0), 100) / 100
		if fraction > 0 {
			let filled = NSRect(
				x: track.minX, y: track.minY, width: max(Self.barHeight, track.width * fraction),
				height: track.height)
			severityColor(window.percent).setFill()
			NSBezierPath(roundedRect: filled, xRadius: Self.barCorner, yRadius: Self.barCorner).fill()
		}

		draw(
			text: "\(Int(window.percent.rounded()))%",
			at: NSPoint(x: track.maxX + 8, y: y + 1),
			font: .monospacedDigitSystemFont(ofSize: 11, weight: .medium),
			color: severityColor(window.percent))

		if let reset = Countdown.describe(window.resetsAt) {
			draw(
				text: reset,
				at: NSPoint(x: track.maxX + 8 + Self.valueWidth, y: y + 1),
				font: .systemFont(ofSize: 11),
				color: tertiaryText)
		}
	}

	private func draw(text: String, at point: NSPoint, font: NSFont, color: NSColor) {
		(text as NSString).draw(at: point, withAttributes: [.font: font, .foregroundColor: color])
	}
}
