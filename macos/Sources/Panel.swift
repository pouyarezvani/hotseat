import AppKit
import Combine
import SwiftUI

// MARK: - Look

extension Color {
	init(hex: UInt32) {
		self.init(
			.sRGB,
			red: Double((hex >> 16) & 0xFF) / 255,
			green: Double((hex >> 8) & 0xFF) / 255,
			blue: Double(hex & 0xFF) / 255,
			opacity: 1)
	}
}

/// The dropdown's own colours, one set for a dark Mac and one for a light one.
struct Theme {
	let surface: Color
	let card: Color
	let cardActive: Color
	let cardHover: Color
	let line: Color
	let text: Color
	let soft: Color
	let faint: Color
	let track: Color
	let accent: Color
	let chip: Color
	let chipOn: Color
	let chipOnText: Color
	let isDark: Bool

	static let dark = Theme(
		surface: Color(hex: 0x151515), card: Color(hex: 0x1C1C1B), cardActive: Color(hex: 0x232322),
		cardHover: Color(hex: 0x262625), line: Color(hex: 0x262625), text: Color(hex: 0xE4E4E0),
		soft: Color(hex: 0xA3A39D), faint: Color(hex: 0x8E8E88), track: Color(hex: 0x2E2E2C),
		accent: Color(hex: 0x7D98FF), chip: Color(hex: 0x222221), chipOn: Color(hex: 0x3B3B38),
		chipOnText: Color(hex: 0xF2F2EE), isDark: true)

	static let light = Theme(
		surface: Color(hex: 0xF4F4F1), card: Color(hex: 0xFAFAF8), cardActive: Color(hex: 0xFFFFFF),
		cardHover: Color(hex: 0xEEEEEA), line: Color(hex: 0xE2E2DD), text: Color(hex: 0x1C1C1B),
		soft: Color(hex: 0x4A4A47), faint: Color(hex: 0x6A6A65), track: Color(hex: 0xE4E4DF),
		accent: Color(hex: 0x2F5BFF), chip: Color(hex: 0xECECE8), chipOn: Color(hex: 0xD6D6D0),
		chipOnText: Color(hex: 0x111111), isDark: false)

	static func of(_ scheme: ColorScheme) -> Theme { scheme == .dark ? .dark : .light }

	/// How full a limit is, as a colour. Darker on a light surface, where the
	/// menu bar's own shades are too pale to read as text.
	func severity(_ percent: Double) -> Color {
		if isDark { return Color(nsColor: Severity(percent: percent).color) }
		switch Severity(percent: percent) {
		case .calm: return Color(hex: 0x0E7A52)
		case .warm: return Color(hex: 0x9A5800)
		case .hot: return Color(hex: 0xC2410C)
		case .spent: return Color(hex: 0xB42318)
		}
	}
}

private struct ThemeKey: EnvironmentKey {
	static let defaultValue = Theme.dark
}

extension EnvironmentValues {
	var theme: Theme {
		get { self[ThemeKey.self] }
		set { self[ThemeKey.self] = newValue }
	}
}

// MARK: - State

enum PanelPage {
	case accounts, settings, history, add
}

/// What the dropdown shows. The app delegate writes it; the views only read it.
final class PanelModel: ObservableObject {
	@Published var board: Board?
	@Published var history: [HistoryEntry] = []
	@Published var page: PanelPage = .accounts
	/// The account whose actions are open, as "service|id".
	@Published var expanded: String?
	/// The setting whose choices are open on the settings page, by its key.
	@Published var openPicker: String?
	/// What the command line said when the board could not be read.
	@Published var loadError = ""
	/// The tallest the scrolling part may grow before it scrolls.
	@Published var maxPageHeight: CGFloat = 520
	/// Called when the content's height changed, so the window can follow it.
	var layoutChanged: () -> Void = {}
}

/// Everything the dropdown can ask the app to do.
struct PanelActions {
	var switchTo: (String, Account) -> Void = { _, _ in }
	var signIn: (String, Account) -> Void = { _, _ in }
	var setEnabled: (String, Account, Bool) -> Void = { _, _, _ in }
	var remove: (String, Account) -> Void = { _, _ in }
	var setSetting: (String, String) -> Void = { _, _ in }
	var switchNow: () -> Void = {}
	var refresh: () -> Void = {}
	var quit: () -> Void = {}
	var add: (String) -> Void = { _ in }
	var addFromToken: () -> Void = {}
	var editAccounts: () -> Void = {}
	var editSettings: () -> Void = {}
}

/// The choices the settings page offers, kept as data so the checks can read
/// them against what the command line accepts.
enum SettingsChoices {
	/// Early, a little early, and then every point from the default up to the
	/// very end, because the right spot between 90 and 99 depends on how long
	/// a turn runs.
	static let thresholdChoices: [Int] = [80, 85] + Array(90...99)

	static let percentageChoices: [(String, String, String)] = [
		("all", "Every limit", "Show one percentage for each limit, in order: 5-hour, weekly, then any model limits, like \u{201C}87% \u{00B7} 72% \u{00B7} 95%\u{201D}."),
		("worst", "Fullest only", "Show a single percentage: whichever limit is closest to running out. That is the one that will trigger a switch."),
		("none", "None", "Show only the service and account name, with no numbers at all."),
	]

	static func thresholdTip(_ value: Int) -> String {
		switch value {
		case 80:
			return "Switch early, once any limit is 80% used. You switch more often, but you never get near running out."
		case 85:
			return "Switch once any limit is 85% used. A little earlier than the default, for extra margin."
		case 90:
			return "Switch once any limit is 90% used. The default: uses each account well while leaving room for a long turn before the switch lands."
		case 99:
			return "Switch only at the very end, once any limit is 99% used. Squeezes everything out of each account, but a single long turn will likely hit the limit first and stop."
		default:
			let left = 100 - value
			return "Switch once any limit is \(value)% used, leaving \(left)% for the turn in progress to finish on. Later means more of each account used; earlier means more margin for a long turn."
		}
	}
}

// MARK: - Pieces

/// Lays chips out left to right, wrapping to a new line when one is full.
struct Flow: Layout {
	var spacing: CGFloat = 6

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let rows = arrange(subviews, width: proposal.width ?? .infinity)
		return CGSize(width: proposal.width ?? rows.width, height: rows.height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		let rows = arrange(subviews, width: bounds.width)
		for (index, point) in rows.points.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
		}
	}

	private func arrange(_ subviews: Subviews, width: CGFloat) -> (points: [CGPoint], width: CGFloat, height: CGFloat) {
		var points: [CGPoint] = []
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		var widest: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.unspecified)
			if x > 0, x + size.width > width {
				x = 0
				y += rowHeight + spacing
				rowHeight = 0
			}
			points.append(CGPoint(x: x, y: y))
			x += size.width + spacing
			rowHeight = max(rowHeight, size.height)
			widest = max(widest, x - spacing)
		}
		return (points, widest, y + rowHeight)
	}
}

private struct HeightKey: PreferenceKey {
	static let defaultValue: CGFloat = 0
	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// As tall as its content until that passes the limit, then it scrolls.
struct FittedScroll<Content: View>: View {
	let maxHeight: CGFloat
	let onHeight: () -> Void
	@ViewBuilder let content: Content
	@State private var height: CGFloat = 0

	var body: some View {
		ScrollView(.vertical) {
			content.background(
				GeometryReader { geometry in
					Color.clear.preference(key: HeightKey.self, value: geometry.size.height)
				})
		}
		// The bar shows only while there is more below, as the cue that there is.
		.scrollIndicators(height > maxHeight ? .visible : .hidden)
		.frame(height: min(max(height, 1), maxHeight))
		.onPreferenceChange(HeightKey.self) { value in
			guard value != height else { return }
			height = value
			onHeight()
		}
	}
}

/// A service's mark, painted in the colour of the text around it.
struct ProviderMark: View {
	let provider: String
	var size: CGFloat = 13

	var body: some View {
		if let colored = Logo.colorImage(for: provider) {
			Image(nsImage: colored)
				.resizable()
				.interpolation(.high)
				.aspectRatio(contentMode: .fit)
				.frame(width: size, height: size)
				.accessibilityHidden(true)
		} else if let image = Logo.image(for: provider, height: size) {
			let mark = Image(nsImage: image)
				.renderingMode(.template)
				.resizable()
				.aspectRatio(contentMode: .fit)
				.frame(width: size, height: size)
				.accessibilityHidden(true)
			// A mark with a colour of its own keeps it; the rest take the text's.
			if let brand = Logo.brandColor(for: provider) {
				mark.foregroundStyle(Color(nsColor: brand))
			} else {
				mark
			}
		}
	}
}

enum ActionKind {
	case primary, ghost, quiet
}

/// Every button in the dropdown. It always explains itself on hover.
struct ActionButton: View {
	let title: String
	var kind: ActionKind = .ghost
	var hint: String?
	var symbol: String?
	let tip: String
	let action: () -> Void
	@Environment(\.theme) private var theme
	@State private var hovering = false

	var body: some View {
		Button(action: action) {
			HStack(spacing: 6) {
				if let symbol {
					Image(systemName: symbol).font(.system(size: 11, weight: .medium))
						.frame(width: 14)
				}
				Text(title).font(.system(size: 12, weight: .medium))
					.lineLimit(1)
				if kind != .ghost || hint != nil { Spacer(minLength: 4) }
				if let hint {
					Text(hint).font(.system(size: 11, design: .monospaced))
						.foregroundStyle(theme.faint)
				}
			}
			.padding(.horizontal, kind == .quiet ? 8 : 11)
			.frame(maxWidth: .infinity, minHeight: kind == .primary ? 32 : 28)
			.foregroundStyle(kind == .primary ? theme.chipOnText : theme.text)
			.background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
			.contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
		.help(tip)
	}

	private var background: Color {
		switch kind {
		case .primary: return hovering ? theme.chipOn : theme.chipOn.opacity(0.75)
		case .ghost: return hovering ? theme.cardHover : theme.chip
		case .quiet: return hovering ? theme.cardHover : .clear
		}
	}
}

/// The way back from a page to the accounts, named for the page it leaves.
struct BackButton: View {
	let title: String
	let action: () -> Void
	@Environment(\.theme) private var theme
	@State private var hovering = false

	var body: some View {
		Button(action: action) {
			HStack(spacing: 6) {
				Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold))
				Text(title).font(.system(size: 13, weight: .medium))
			}
			.foregroundStyle(theme.text)
			.padding(.horizontal, 8)
			.frame(height: 28)
			.background(hovering ? theme.cardHover : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
			.contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
		.help("Go back to the list of your accounts and their limits.")
	}
}

/// One on-or-off setting, drawn as a switch.
struct ToggleRow: View {
	let title: String
	let key: String
	let on: Bool
	let tip: String
	let set: (String, String) -> Void
	@Environment(\.theme) private var theme
	@State private var hovering = false

	var body: some View {
		Button {
			set(key, on ? "false" : "true")
		} label: {
			HStack {
				Text(title).font(.system(size: 12)).foregroundStyle(theme.text)
				Spacer(minLength: 8)
				Capsule()
					.fill(on ? theme.accent : theme.track)
					.frame(width: 30, height: 18)
					.overlay(alignment: on ? .trailing : .leading) {
						Circle().fill(Color.white).frame(width: 14, height: 14).padding(2)
					}
			}
			.padding(.horizontal, 10)
			.frame(minHeight: 30)
			.background(hovering ? theme.cardHover : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
		.help(tip)
		.accessibilityValue(on ? "on" : "off")
	}
}

/// One choice out of several, drawn as a pill that fills in when chosen.
struct ChoiceChip: View {
	let title: String
	let key: String
	let value: String
	let chosen: Bool
	var locked = false
	let tip: String
	let set: (String, String) -> Void
	@Environment(\.theme) private var theme
	@State private var hovering = false

	var body: some View {
		Button {
			set(key, value)
		} label: {
			Text(title)
				.font(.system(size: 11, weight: chosen ? .semibold : .regular))
				.monospacedDigit()
				.foregroundStyle(chosen ? theme.chipOnText : theme.text)
				.padding(.horizontal, 9)
				.frame(minHeight: 24)
				.background(background, in: Capsule())
				.overlay(Capsule().strokeBorder(theme.faint.opacity(hovering && !locked ? 0.55 : 0), lineWidth: 1))
				.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.disabled(locked)
		.onHover { hovering = $0 }
		.help(tip)
		.accessibilityAddTraits(chosen ? .isSelected : [])
	}

	/// Under the cursor a chip lifts a step toward the chosen look, and a
	/// chosen one a step past it, so every chip answers a hover.
	private var background: Color {
		let over = hovering && !locked
		if chosen { return over ? theme.chipOn.opacity(theme.isDark ? 1 : 0.8) : theme.chipOn.opacity(theme.isDark ? 0.8 : 1) }
		return over ? theme.chipOn.opacity(0.5) : theme.chip
	}
}

/// One setting with many choices: its name and the value chosen, which opens
/// the choices underneath when clicked and closes again once one is picked.
struct PickerRow<Choices: View>: View {
	let title: String
	let value: String
	let isOpen: Bool
	let tip: String
	let toggle: () -> Void
	@ViewBuilder let choices: Choices
	@Environment(\.theme) private var theme
	@State private var hovering = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Button(action: toggle) {
				HStack(spacing: 6) {
					Text(title).font(.system(size: 12)).foregroundStyle(theme.text)
					Spacer(minLength: 8)
					Text(value).font(.system(size: 11, weight: .medium)).monospacedDigit()
						.foregroundStyle(theme.text)
					Image(systemName: isOpen ? "chevron.up" : "chevron.down")
						.font(.system(size: 9, weight: .semibold)).foregroundStyle(theme.faint)
				}
				.padding(.horizontal, 10)
				.frame(minHeight: 30)
				.background(
					hovering || isOpen ? theme.cardHover : .clear,
					in: RoundedRectangle(cornerRadius: 8, style: .continuous)
				)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.onHover { hovering = $0 }
			.help(tip)
			.accessibilityValue(value)
			if isOpen {
				Flow { choices }.padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 6)
			}
		}
	}
}

/// The small label over a group of settings or accounts.
struct SectionLabel: View {
	let text: String
	let tip: String
	@Environment(\.theme) private var theme

	var body: some View {
		Text(text.uppercased())
			.font(.system(size: 10, weight: .semibold, design: .monospaced))
			.tracking(0.8)
			.foregroundStyle(theme.faint)
			.help(tip)
	}
}

/// One limit: its name, a bar, how full it is and when it resets.
private struct MeterBar: View {
	let percent: Double
	@Environment(\.theme) private var theme

	var body: some View {
		GeometryReader { geometry in
			let fraction = min(max(percent, 0), 100) / 100
			ZStack(alignment: .leading) {
				Capsule().fill(theme.track)
				if fraction > 0 {
					Capsule().fill(theme.severity(percent))
						.frame(width: max(geometry.size.height, geometry.size.width * fraction))
				}
			}
		}
		.frame(height: 5)
	}
}

// MARK: - Accounts

struct AccountCard: View {
	let providerId: String
	let providerTitle: String
	let account: Account
	let isActive: Bool
	@ObservedObject var model: PanelModel
	let actions: PanelActions
	@Environment(\.theme) private var theme
	@State private var hovering = false

	private var canSwitch: Bool { !isActive && !account.disabled }
	private var token: String { "\(providerId)|\(account.id)" }
	private var isOpen: Bool { model.expanded == token }

	private static let bars =
		"Each bar is one of this account's limits and how much of it is used. The time on the right is when that limit resets."

	private var tip: String { "\(account.email). " + state }

	private var state: String {
		if account.disabled {
			return "This account is turned off, so automatic switching skips it. You can still switch to it from its options. " + Self.bars
		}
		if isActive { return "This is the account \(providerTitle) is using right now. " + Self.bars }
		return "Click to switch \(providerTitle) to this account. " + Self.bars
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			summary
				.contentShape(Rectangle())
				.onTapGesture { if canSwitch { actions.switchTo(providerId, account) } }
				.accessibilityElement(children: .combine)
				.accessibilityAddTraits(canSwitch ? .isButton : [])
				.accessibilityAction { if canSwitch { actions.switchTo(providerId, account) } }
				.help(tip)
			if isOpen { options }
		}
		.background(
			hovering && canSwitch ? theme.cardHover : (isActive ? theme.cardActive : theme.card),
			in: RoundedRectangle(cornerRadius: 12, style: .continuous)
		)
		.onHover { hovering = $0 }
	}

	private var summary: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 8) {
				Circle()
					.fill(isActive ? theme.severity(account.worstPercent) : Color.clear)
					.overlay(Circle().strokeBorder(isActive ? Color.clear : theme.faint, lineWidth: 1))
					.frame(width: 8, height: 8)
				Text(account.displayName)
					.font(.system(size: 13, weight: isActive ? .medium : .regular))
					.foregroundStyle(account.disabled ? theme.faint : (isActive ? theme.text : theme.soft))
					.lineLimit(1)
					.truncationMode(.middle)
				Spacer(minLength: 6)
				if isActive {
					Text("IN USE").badge(theme.accent, on: theme.accent.opacity(0.16))
				} else if account.disabled {
					Text("OFF").badge(theme.faint, on: theme.chip)
				}
				Button {
					model.expanded = isOpen ? nil : token
				} label: {
					Image(systemName: "ellipsis")
						.font(.system(size: 12, weight: .semibold))
						.foregroundStyle(isOpen ? theme.text : theme.faint)
						.frame(width: 24, height: 22)
						.background(isOpen ? theme.chip : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Options for \(account.displayName)")
				.help("Show or hide what you can do with this account, along with its plan and when its numbers were last read.")
			}
			readings
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 12)
	}

	@ViewBuilder private var readings: some View {
		let windows = account.usage?.shown ?? []
		if !windows.isEmpty {
			Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 7) {
				ForEach(windows, id: \.key) { window in
					GridRow {
						Text(window.label).font(.system(size: 11)).foregroundStyle(theme.soft)
							.lineLimit(1).fixedSize()
						MeterBar(percent: window.percent)
						Text("\(Int(window.percent.rounded()))%")
							.font(.system(size: 11, weight: .medium, design: .monospaced))
							.foregroundStyle(theme.severity(window.percent))
							.gridColumnAlignment(.trailing)
						Text(Countdown.describe(window.resetsAt) ?? "")
							.font(.system(size: 11, design: .monospaced))
							.foregroundStyle(theme.faint)
							.gridColumnAlignment(.trailing)
					}
				}
			}
			.padding(.leading, 16)
			if let pace {
				Text(pace).font(.system(size: 11)).foregroundStyle(theme.severity(70))
					.fixedSize(horizontal: false, vertical: true)
					.padding(.leading, 16)
					.help("Worked out from how fast this limit has filled lately: the last hour and a half for one that resets within six hours, the last twelve hours otherwise. It only shows when the limit would fill before it resets.")
			}
		}
		if let error = account.usage?.error {
			Text(windows.isEmpty ? error : "last read failed: \(error)")
				.font(.system(size: 11)).foregroundStyle(theme.faint)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.leading, 16)
		} else if windows.isEmpty {
			Text(account.usage?.note ?? "no reading yet").font(.system(size: 11)).foregroundStyle(theme.faint).padding(.leading, 16)
		}
	}

	/// The limit that will fill first at the present pace, said in a line.
	private var pace: String? {
		let filling = (account.usage?.shown ?? [])
			.compactMap { window in Countdown.describe(window.fullAt).map { (window.label, $0, window.fullAt ?? "") } }
			.min { $0.2 < $1.2 }
		return filling.map { "At this pace, \($0.0) is full in \($0.1), before it resets." }
	}

	private var options: some View {
		let pickup =
			providerId == "claude"
			? "Open Claude sessions, including ones in your editor, pick this up on their own within a moment."
			: "Open \(providerTitle) sessions keep the old account until they restart."
		let needsSignIn = account.usage?.error?.contains("no longer works") ?? false
		let signIn = ActionButton(
			title: "Sign in again\u{2026}", kind: .quiet, symbol: "arrow.clockwise",
			tip: "Open your browser to sign in to this account again, the same way adding it did. Use this when its saved login has stopped working. Nothing else is signed out, and the account you are using stays as it is."
		) { actions.signIn(providerId, account) }
		return VStack(alignment: .leading, spacing: 1) {
			Rectangle().fill(theme.line).frame(height: 1).padding(.bottom, 4)
			if needsSignIn { signIn }
			if !isActive {
				ActionButton(
					title: "Switch to this account", kind: .quiet, symbol: "arrow.right",
					tip: "Make this the account \(providerTitle) uses from now on. \(pickup)"
				) { actions.switchTo(providerId, account) }
			}
			ActionButton(
				title: account.disabled ? "Enable" : "Disable", kind: .quiet,
				symbol: account.disabled ? "play" : "pause",
				tip: account.disabled
					? "Put this account back into automatic switching, so hotseat may move to it when another account runs out."
					: "Take this account out of automatic switching. hotseat will never move to it on its own. It stays saved, and you can still switch to it by hand."
			) { actions.setEnabled(providerId, account, account.disabled) }
			if !needsSignIn { signIn }
			ActionButton(
				title: "Remove account", kind: .quiet, symbol: "trash",
				tip: "Forget this account and delete its saved login from this Mac. The account itself is not affected, and you can add it again later. You will be asked to confirm."
			) { actions.remove(providerId, account) }
			trends
			if let facts {
				Text(facts).font(.system(size: 11)).foregroundStyle(theme.faint)
					.padding(.horizontal, 8).padding(.top, 5)
					.help("The subscription plan this account is on, and when these numbers were last read successfully. If a read fails, the last good numbers stay on screen rather than going blank.")
			}
		}
		.padding(.horizontal, 6)
		.padding(.bottom, 8)
	}

	/// Each limit's last week as a small line, for the limits that have one.
	@ViewBuilder private var trends: some View {
		let drawn = (account.usage?.shown ?? []).filter { ($0.trend?.count ?? 0) > 1 }
		if !drawn.isEmpty {
			VStack(alignment: .leading, spacing: 6) {
				Text("LAST 7 DAYS")
					.font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(0.6)
					.foregroundStyle(theme.faint)
				ForEach(drawn, id: \.key) { window in
					HStack(spacing: 10) {
						Text(window.label).font(.system(size: 11)).foregroundStyle(theme.soft)
							.lineLimit(1).frame(width: 110, alignment: .leading)
						TrendLine(values: window.trend ?? [])
							.stroke(theme.soft, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
							.frame(height: 18)
							.accessibilityLabel("\(window.label) over the last week, now \(Int(window.percent.rounded())) percent")
					}
				}
			}
			.padding(.horizontal, 8).padding(.top, 8)
			.help("How full each limit has been over the last week, oldest on the left. The line runs from empty at the bottom to full at the top, and drops where the limit reset.")
		}
	}

	private var facts: String? {
		var parts: [String] = []
		if let plan = account.plan {
			// A plan the service wrote out in full keeps its own capitals.
			let name = plan.contains(where: \.isUppercase) ? plan : plan.capitalized
			parts.append(name.lowercased().hasSuffix("plan") ? name : "\(name) plan")
		}
		if let fetched = account.usage?.fetchedAt {
			parts.append("Last good reading \(Countdown.shortStamp(fetched))")
		}
		return parts.isEmpty ? nil : parts.joined(separator: "  \u{00B7}  ")
	}
}

/// A limit's history as a line, empty at the bottom and full at the top.
struct TrendLine: Shape {
	let values: [Double]

	func path(in rect: CGRect) -> Path {
		var path = Path()
		guard values.count > 1 else { return path }
		for (index, value) in values.enumerated() {
			let x = rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1)
			let y = rect.maxY - rect.height * CGFloat(min(max(value, 0), 100) / 100)
			if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
		}
		return path
	}
}

extension Text {
	fileprivate func badge(_ color: Color, on background: Color) -> some View {
		self.font(.system(size: 9, weight: .semibold, design: .monospaced))
			.tracking(0.6)
			.foregroundStyle(color)
			.padding(.horizontal, 6)
			.frame(height: 17)
			.background(background, in: Capsule())
	}
}

struct AccountsPage: View {
	@ObservedObject var model: PanelModel
	let actions: PanelActions
	@Environment(\.theme) private var theme

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			if let board = model.board, !board.orderedProviders.isEmpty {
				ForEach(board.orderedProviders, id: \.id) { entry in
					VStack(alignment: .leading, spacing: 7) {
						header(entry, board: board)
						ForEach(entry.state.accounts, id: \.id) { account in
							AccountCard(
								providerId: entry.id, providerTitle: entry.title, account: account,
								isActive: account.id == entry.state.activeAccountId, model: model,
								actions: actions)
						}
					}
				}
			} else if model.board == nil, !model.loadError.isEmpty {
				notice(
					"hotseat could not read its files",
					"The command line answered with an error instead of your accounts: \(model.loadError). Fix the file it names, or run  hotseat status  in a terminal to see the full message.")
			} else {
				notice(
					"No accounts yet",
					"No account has been added. Save a login this Mac already has from Add an account below, or run  hotseat add  in a terminal to sign in to one.")
			}
		}
	}

	private func header(_ entry: (id: String, title: String, state: ProviderState), board: Board) -> some View {
		let spare = entry.state.switchableCount(countingModels: board.settings.autoModelLimits)
		return HStack(spacing: 7) {
			ProviderMark(provider: entry.id).foregroundStyle(theme.soft)
			Text(entry.title).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text)
			if let service = board.services[entry.id], service.isShown {
				Text(service.level == "maintenance" ? "MAINTENANCE" : "SERVICE ISSUE")
					.font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(0.6)
					.foregroundStyle(theme.severity(service.level == "minor" || service.level == "maintenance" ? 70 : 97))
					.padding(.horizontal, 6).frame(height: 17)
					.background(theme.chip, in: Capsule())
					.help("\(service.summary). This is what \(service.url) reports right now; hotseat reads it every five minutes.")
			}
			Spacer()
			Text(spare == 0 ? "nothing to switch to" : "\(spare) to switch to")
				.font(.system(size: 11)).foregroundStyle(theme.faint)
		}
		.padding(.horizontal, 2)
		.help(
			"Your \(entry.title) accounts. The count is how many you could switch to right now: accounts that are on, not already in use, and have at least \(Int(Account.minimumUsableHeadroom))% left on their fullest limit.")
	}

	private func notice(_ title: String, _ detail: String) -> some View {
		VStack(alignment: .leading, spacing: 5) {
			Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text)
			Text(detail).font(.system(size: 12)).foregroundStyle(theme.soft)
				.fixedSize(horizontal: false, vertical: true)
		}
		.padding(12)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
	}
}

// MARK: - Other pages

struct AddPage: View {
	let actions: PanelActions
	@Environment(\.theme) private var theme

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			ForEach(Board.providerOrder, id: \.self) { id in
				let title = Board.providerTitles[id] ?? id
				ActionButton(
					title: "Save the \(title) login this Mac is signed in to", symbol: "plus",
					tip: "Add the account \(title) is signed in to on this Mac right now, using its existing login. Nothing is signed out and nothing changes for \(title)."
				) { actions.add(id) }
			}
			ActionButton(
				title: "Add a Claude account from a setup token\u{2026}", symbol: "key",
				tip: "Add a Claude account by pasting a token you get from running  claude setup-token  in a terminal. Useful when you cannot sign in through the browser. A setup token has fewer permissions than a normal sign-in, so  hotseat add  is usually better."
			) { actions.addFromToken() }
			Text("To sign in to a new account, run  hotseat add  in a terminal. Nothing is ever signed out.")
				.font(.system(size: 11)).foregroundStyle(theme.faint)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.top, 6).padding(.horizontal, 2)
				.help("hotseat add opens your browser so you can sign in to any account and adds it here. Adding an account never signs any account out; only Remove account deletes a saved login, and only from hotseat.")
		}
	}
}

struct HistoryPage: View {
	let entries: [HistoryEntry]
	@Environment(\.theme) private var theme

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if entries.isEmpty {
				Text("No switches yet").font(.system(size: 12)).foregroundStyle(theme.soft)
					.help("Once an account changes, by hand or automatically, it is listed here.")
			}
			ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
				if index > 0 { Rectangle().fill(theme.line).frame(height: 1) }
				row(entry)
			}
		}
	}

	private func why(_ reason: String) -> String {
		switch reason {
		case "auto": return "hotseat switched automatically because a limit filled up"
		case "manual": return "you switched by hand"
		case "best": return "you chose Switch now"
		case "rotate": return "you asked for the next account in order"
		case "next": return "you asked for the next account with room"
		default: return reason
		}
	}

	private func shorten(_ email: String) -> String {
		email.split(separator: "@").first.map(String.init) ?? email
	}

	private func row(_ entry: HistoryEntry) -> some View {
		let service = Board.providerTitles[entry.provider] ?? entry.provider
		return HStack(alignment: .firstTextBaseline, spacing: 8) {
			ProviderMark(provider: entry.provider, size: 11).foregroundStyle(theme.soft)
			VStack(alignment: .leading, spacing: 2) {
				Text("\(entry.from.map(shorten) ?? "\u{2014}")  \u{2192}  \(shorten(entry.to))")
					.font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
				Text(why(entry.reason)).font(.system(size: 11)).foregroundStyle(theme.faint)
					.fixedSize(horizontal: false, vertical: true)
			}
			Spacer(minLength: 6)
			Text(Countdown.shortStamp(entry.at)).font(.system(size: 11, design: .monospaced))
				.foregroundStyle(theme.faint)
		}
		.padding(.vertical, 8)
		.help("At \(Countdown.shortStamp(entry.at)), \(service) changed from \(entry.from ?? "no account") to \(entry.to): \(why(entry.reason)).")
	}
}

struct SettingsPage: View {
	@ObservedObject var model: PanelModel
	let actions: PanelActions
	@Environment(\.theme) private var theme

	var body: some View {
		if let board = model.board {
			content(board.settings, board: board)
		} else {
			Text("Settings could not be read. Run  hotseat config reset  in a terminal to restore the defaults.")
				.font(.system(size: 12)).foregroundStyle(theme.soft)
				.fixedSize(horizontal: false, vertical: true)
				.help("hotseat could not read its settings file. Run  hotseat config reset  in a terminal to restore the defaults.")
		}
	}

	private func group<Content: View>(_ title: String, tip: String, @ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			SectionLabel(text: title, tip: tip).padding(.horizontal, 2)
			VStack(alignment: .leading, spacing: 2) { content() }
				.padding(6)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
		}
	}

	private func choices<Content: View>(_ title: String, tip: String, @ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 7) {
			Text(title).font(.system(size: 12)).foregroundStyle(theme.text).help(tip)
			Flow { content() }
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 7)
	}

	private func content(_ settings: Settings, board: Board) -> some View {
		let set = actions.setSetting
		let shown = board.orderedProviders
		let chosenProviders = settings.titleProviders
		let visible = shown.filter { chosenProviders.contains($0.id) }
		let chosenModels = Set(settings.autoModelLimits.map { $0.lowercased() })
		let seenModels = Array(Set(shown.flatMap { $0.state.accounts.flatMap(\.modelLimitNames) })).sorted()
		return VStack(alignment: .leading, spacing: 16) {
			group("Menu bar", tip: "How the text in your menu bar looks, and which services appear in it.") {
				if !shown.isEmpty {
					choices(
						"Show in the menu bar",
						tip: "Which services appear in the menu bar text. Every service always appears in this dropdown; this only decides what sits in the bar itself."
					) {
						ForEach(shown, id: \.id) { entry in
							let isOn = chosenProviders.contains(entry.id)
							let last = isOn && visible.count <= 1
							let next = isOn
								? chosenProviders.filter { $0 != entry.id }
								: Board.providerOrder.filter { chosenProviders.contains($0) || $0 == entry.id }
							ChoiceChip(
								title: entry.title, key: "titleProviders", value: next.joined(separator: ","),
								chosen: isOn, locked: last,
								tip: last
									? "\(entry.title) is the only service in the menu bar, and one has to stay. Turn another one on first to take this one out."
									: isOn
										? "\(entry.title) is in the menu bar text. Click to take it out; it stays in this dropdown."
										: "\(entry.title) is not in the menu bar text. Click to put it there.",
								set: set)
						}
					}
				}
				ToggleRow(
					title: "Compact title", key: "titleCompact", on: settings.titleCompact,
					tip: "Shorten the menu bar text to just the service and its fullest limit, like \u{201C}Claude 93%\u{201D}. Turn it off to see the account name and every limit.",
					set: set)
				ToggleRow(
					title: "Show the account name", key: "titleShowAccount", on: settings.titleShowAccount,
					tip: "Include the name of the account in use in the menu bar text, like \u{201C}Claude \u{2014} pouya\u{201D}. Has no effect while Compact title is on.",
					set: set)
				ToggleRow(
					title: "Show model limits", key: "titleShowModelLimits", on: settings.titleShowModelLimits,
					tip: "Some models have their own weekly limit, like Fable. Include those in the menu bar text alongside the 5-hour and weekly limits. This is only about what is shown; whether they count for switching is the setting below.",
					set: set)
				choices("Percentages in the title", tip: "Which percentages appear in the menu bar text.") {
					ForEach(SettingsChoices.percentageChoices, id: \.0) { choice in
						ChoiceChip(
							title: choice.1, key: "titlePercentage", value: choice.0,
							chosen: settings.titlePercentage == choice.0, tip: choice.2, set: set)
					}
				}
			}

			group(
				"Switching",
				tip: "hotseat switches for you, always. When a limit on the account in use fills up, it moves to the account that resets soonest and still has something left. These settings decide when that happens and which limits count."
			) {
				PickerRow(
					title: "Switch once a limit reaches", value: "\(Int(settings.autoThresholdPercent))%",
					isOpen: model.openPicker == "autoThresholdPercent",
					tip: "How full a limit has to get before hotseat switches you to another account. Any limit counts: the 5-hour, the weekly, or a model limit you have chosen to count below. Click to choose.",
					toggle: { togglePicker("autoThresholdPercent") }
				) {
					ForEach(SettingsChoices.thresholdChoices, id: \.self) { value in
						ChoiceChip(
							title: "\(value)%", key: "autoThresholdPercent", value: String(value),
							chosen: Int(settings.autoThresholdPercent) == value,
							tip: SettingsChoices.thresholdTip(value), set: pick)
					}
				}
				window(
					"5-hour limit", key: "autoThresholdFiveHour", current: settings.autoThresholdFiveHour,
					tip: "A limit of its own for the 5-hour window. It refills quickly, so many people let it run higher than the weekly one. \u{201C}Same\u{201D} uses the general limit.")
				window(
					"Weekly limit", key: "autoThresholdWeekly", current: settings.autoThresholdWeekly,
					tip: "A limit of its own for the weekly window. This is the quota that expires unused, so some people spend it further than the 5-hour one. \u{201C}Same\u{201D} uses the general limit.")
				choices(
					"Also count a model\u{2019}s own limit",
					tip: "Besides the 5-hour and weekly limits, some models have their own weekly limit, like Fable. Choose whether those count when deciding to switch. Count a model you use; ignore one you do not, or hotseat will switch you away for a limit that was never in your way."
				) {
					ChoiceChip(
						title: "None", key: "autoModelLimits", value: "", chosen: chosenModels.isEmpty,
						tip: "Only the 5-hour and weekly limits decide when to switch. A model\u{2019}s own limit is still shown, but ignored. Choose this if you do not use the models that have their own limit.",
						set: set)
					ChoiceChip(
						title: "Every model", key: "autoModelLimits", value: "all", chosen: chosenModels.contains("all"),
						tip: "Every model\u{2019}s own limit counts. If any model you have is at its limit, hotseat switches, even when the 5-hour and weekly limits still have room.",
						set: set)
					ForEach(seenModels, id: \.self) { name in
						let isOn = chosenModels.contains(name.lowercased())
						let next = isOn
							? settings.autoModelLimits.filter { $0.lowercased() != name.lowercased() }
							: settings.autoModelLimits.filter { $0.lowercased() != "all" } + [name]
						ChoiceChip(
							title: name, key: "autoModelLimits", value: next.joined(separator: ","), chosen: isOn,
							tip: "Count \(name)\u{2019}s own weekly limit. If \(name) is at its limit, hotseat switches even when the 5-hour and weekly limits still have room. Choose this if you use \(name).",
							set: set)
					}
				}
			}

			group(
				"Accounts",
				tip: "Which services hotseat looks for on this Mac, so an account you are signed in to shows up without adding it."
			) {
				choices(
					"Find signed-in accounts by itself",
					tip: "When one of these services is signed in on this Mac and has no account saved here, hotseat adds that account on its next check. Removing a service's last account turns this off for it, so the account does not come straight back."
				) {
					ForEach(Board.providerOrder, id: \.self) { id in
						let name = Board.providerTitles[id] ?? id
						let isOn = settings.autoDetectProviders.contains(id)
						let next = isOn
							? settings.autoDetectProviders.filter { $0 != id }
							: Board.providerOrder.filter { settings.autoDetectProviders.contains($0) || $0 == id }
						ChoiceChip(
							title: name, key: "autoDetectProviders", value: next.joined(separator: ","), chosen: isOn,
							tip: isOn
								? "hotseat looks for a signed-in \(name) account and adds it by itself. Click to stop looking."
								: "hotseat does not look for a \(name) account. Click to have it added by itself once \(name) is signed in.",
							set: set)
					}
				}
			}

			group("Files", tip: "The two files hotseat keeps for you to edit by hand.") {
				ActionButton(
					title: "Edit accounts.json\u{2026}", kind: .quiet, symbol: "doc.text",
					tip: "Open the file that lists every account and its saved login in Cursor or VS Code, whichever is installed. Add an account by writing an entry with a service and an email; delete an entry to forget it. Keep this file to yourself: it holds live logins."
				) { actions.editAccounts() }
				ActionButton(
					title: "Edit settings.json\u{2026}", kind: .quiet, symbol: "doc.text",
					tip: "Open your settings file in Cursor or VS Code, whichever is installed. It holds only the settings you have changed; run  hotseat config  in a terminal to see every key and its allowed values."
				) { actions.editSettings() }
			}
		}
	}

	/// The choices giving one window a limit of its own, or none.
	private func window(_ title: String, key: String, current: Double, tip: String) -> some View {
		PickerRow(
			title: title, value: Int(current) == 0 ? "Same" : "\(Int(current))%",
			isOpen: model.openPicker == key, tip: tip, toggle: { togglePicker(key) }
		) {
			ChoiceChip(
				title: "Same", key: key, value: "0", chosen: Int(current) == 0,
				tip: "This window follows the general limit above, with no limit of its own.",
				set: pick)
			ForEach(SettingsChoices.thresholdChoices, id: \.self) { value in
				ChoiceChip(
					title: "\(value)%", key: key, value: String(value), chosen: Int(current) == value,
					tip: "Switch once this window is \(value)% used, whatever the general limit says. The other windows keep theirs.",
					set: pick)
			}
		}
	}

	private func togglePicker(_ key: String) {
		model.openPicker = model.openPicker == key ? nil : key
	}

	/// A choice made from an open picker is saved, and the picker closes.
	private func pick(_ key: String, _ value: String) {
		model.openPicker = nil
		actions.setSetting(key, value)
	}
}

// MARK: - The dropdown

struct PanelView: View {
	@ObservedObject var model: PanelModel
	let actions: PanelActions
	@Environment(\.colorScheme) private var scheme

	static let width: CGFloat = 480
	private static let corner: CGFloat = 16

	var body: some View {
		let theme = Theme.of(scheme)
		VStack(alignment: .leading, spacing: 0) {
			header(theme)
			FittedScroll(maxHeight: model.maxPageHeight, onHeight: model.layoutChanged) {
				page.padding(.horizontal, 12).padding(.bottom, 12)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			if model.page == .accounts { footer(theme) }
		}
		.frame(width: Self.width)
		.background(theme.surface)
		.clipShape(RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: Self.corner, style: .continuous).strokeBorder(theme.line, lineWidth: 1)
		)
		.environment(\.theme, theme)
		.fixedSize(horizontal: false, vertical: true)
	}

	@ViewBuilder private var page: some View {
		switch model.page {
		case .accounts: AccountsPage(model: model, actions: actions)
		case .settings: SettingsPage(model: model, actions: actions)
		case .history: HistoryPage(entries: model.history)
		case .add: AddPage(actions: actions)
		}
	}

	private var pageTitle: String {
		switch model.page {
		case .accounts: return "hotseat"
		case .settings: return "Settings"
		case .history: return "Recent switches"
		case .add: return "Add an account"
		}
	}

	private func header(_ theme: Theme) -> some View {
		HStack(spacing: 8) {
			if model.page == .accounts {
				Text("HOTSEAT")
					.font(.system(size: 11, weight: .semibold, design: .monospaced))
					.tracking(1.6)
					.foregroundStyle(theme.soft)
				Spacer()
				if let updated = model.board?.updatedAt {
					Text("read \(Countdown.shortStamp(updated))")
						.font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.faint)
						.help("When hotseat last looked at your accounts. Each account's own numbers are read on a schedule that speeds up as it gets close to a limit.")
				}
			} else {
				BackButton(title: pageTitle) { model.page = .accounts }
				Spacer()
			}
		}
		.padding(.horizontal, model.page == .accounts ? 14 : 8)
		.frame(height: 42)
	}

	private func footer(_ theme: Theme) -> some View {
		VStack(spacing: 6) {
			ActionButton(
				title: "Switch now", kind: .primary, hint: "\u{2318}B",
				tip: "Switch right away instead of waiting for a limit to fill up. Goes to the account that resets soonest and still has something left, which is the same choice automatic switching makes.",
				action: actions.switchNow
			)
			.keyboardShortcut("b", modifiers: .command)
			HStack(spacing: 6) {
				ActionButton(
					title: "Add account", symbol: "plus",
					tip: "Save a login this Mac already has, or add a Claude account from a setup token. Nothing is ever signed out."
				) { model.page = .add }
				ActionButton(
					title: "History", symbol: "clock",
					tip: "The last dozen times the account changed, newest first, with why it changed."
				) { model.page = .history }
				ActionButton(
					title: "Settings", symbol: "slider.horizontal.3",
					tip: "What the menu bar shows, and when hotseat switches accounts for you."
				) { model.page = .settings }
			}
			HStack(spacing: 6) {
				ActionButton(
					title: "Refresh", hint: "\u{2318}R", symbol: "arrow.clockwise",
					tip: "Read every account's limits again right now instead of waiting for the next check. Numbers read under a minute ago are kept as they are.",
					action: actions.refresh
				)
				.keyboardShortcut("r", modifiers: .command)
				ActionButton(
					title: "Quit", hint: "\u{2318}Q", symbol: "power",
					tip: "Close the menu bar app. Automatic switching stops until you open it again with  hotseat menubar  in a terminal.",
					action: actions.quit
				)
				.keyboardShortcut("q", modifiers: .command)
			}
		}
		.padding(.horizontal, 12)
		.padding(.top, 10)
		.padding(.bottom, 10)
		.overlay(alignment: .top) { Rectangle().fill(theme.line).frame(height: 1) }
	}
}

// MARK: - Window

/// A borderless window that can still take the keyboard, so shortcuts and
/// Escape work while the app itself stays in the background.
final class DropdownWindow: NSPanel {
	var onCancel: () -> Void = {}
	override var canBecomeKey: Bool { true }
	override func cancelOperation(_ sender: Any?) { onCancel() }
}

/// Shows the dropdown under the menu bar button and closes it on a click
/// anywhere else.
final class DropdownController {
	let model: PanelModel
	private let window: DropdownWindow
	private let hosting: NSHostingView<PanelView>
	private weak var anchor: NSStatusBarButton?
	private var monitors: [Any] = []
	private var changes: AnyCancellable?
	private static let gap: CGFloat = 6
	private static let margin: CGFloat = 8

	init(model: PanelModel, actions: PanelActions) {
		self.model = model
		hosting = NSHostingView(rootView: PanelView(model: model, actions: actions))
		window = DropdownWindow(
			contentRect: NSRect(x: 0, y: 0, width: PanelView.width, height: 300),
			styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
		window.isOpaque = false
		window.backgroundColor = .clear
		window.hasShadow = true
		window.level = .popUpMenu
		window.isMovable = false
		window.hidesOnDeactivate = false
		window.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
		window.contentView = hosting
		window.onCancel = { [weak self] in self?.close() }
		model.layoutChanged = { [weak self] in
			DispatchQueue.main.async { self?.fit() }
		}
		changes = model.objectWillChange.sink { [weak self] _ in
			DispatchQueue.main.async { self?.fit() }
		}
	}

	var isOpen: Bool { window.isVisible }

	func toggle(from button: NSStatusBarButton) {
		if isOpen { close() } else { open(from: button) }
	}

	func open(from button: NSStatusBarButton) {
		anchor = button
		model.page = .accounts
		model.expanded = nil
		model.openPicker = nil
		let screen = button.window?.screen ?? NSScreen.main
		// Room for the header and the footer, which never scroll.
		model.maxPageHeight = max(240, (screen?.visibleFrame.height ?? 800) - 230)
		fit()
		window.makeKeyAndOrderFront(nil)
		button.highlight(true)
		DispatchQueue.main.async { [weak self] in self?.fit() }
		let outside: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
		if let global = NSEvent.addGlobalMonitorForEvents(matching: outside, handler: { [weak self] _ in
			self?.close()
		}) {
			monitors.append(global)
		}
		if let local = NSEvent.addLocalMonitorForEvents(matching: outside, handler: { [weak self] event in
			guard let self else { return event }
			// A click on the menu bar button is the button's own to handle.
			if event.window !== self.window, event.window !== self.anchor?.window { self.close() }
			return event
		}) {
			monitors.append(local)
		}
	}

	func close() {
		guard isOpen else { return }
		for monitor in monitors { NSEvent.removeMonitor(monitor) }
		monitors.removeAll()
		window.orderOut(nil)
		anchor?.highlight(false)
	}

	/// Sizes the window to its content and hangs it under the button, pulled in
	/// from the screen's edge when the button sits close to it.
	private func fit() {
		let size = hosting.fittingSize
		guard size.height > 1 else { return }
		guard let button = anchor, let buttonWindow = button.window else {
			window.setContentSize(size)
			return
		}
		let buttonFrame = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
		let visible = (buttonWindow.screen ?? NSScreen.main)?.visibleFrame ?? .zero
		var x = buttonFrame.minX
		x = min(x, visible.maxX - size.width - Self.margin)
		x = max(x, visible.minX + Self.margin)
		let top = buttonFrame.minY - Self.gap
		let frame = NSRect(x: x, y: top - size.height, width: size.width, height: size.height)
		guard frame != window.frame else { return }
		window.setFrame(frame, display: true)
		window.invalidateShadow()
	}
}
