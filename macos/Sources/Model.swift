import AppKit

struct UsageWindow: Decodable {
	let key: String
	let label: String
	let percent: Double
	let resetsAt: String?
}

struct UsageSnapshot: Decodable {
	let fetchedAt: String
	let windows: [UsageWindow]
	let error: String?
}

struct Account: Decodable {
	let id: String
	let email: String
	let slot: Int
	let alias: String?
	let plan: String?
	let disabled: Bool
	let usage: UsageSnapshot?

	/// An account with a sliver of quota left is not worth switching to: it would
	/// be spent within a turn or two. Mirrors MIN_USABLE_HEADROOM in the CLI.
	static let minimumUsableHeadroom: Double = 5

	var displayName: String { alias ?? email }
	var worstPercent: Double { usage?.windows.map(\.percent).max() ?? 0 }
	var headroom: Double { 100 - worstPercent }
	var hasReadings: Bool { !(usage?.windows.isEmpty ?? true) }
}

struct ProviderState: Decodable {
	let activeAccountId: String?
	let accounts: [Account]
}

struct Settings: Decodable {
	let titleCompact: Bool
	let titleShowAccount: Bool
	let titlePercentage: String
	let titleShowModelLimits: Bool
	let titleShortenEmail: Bool
	let autoEnabled: Bool
	let autoThresholdPercent: Double
	let autoStrategy: String
	let refreshIntervalSeconds: Double
}

struct Board: Decodable {
	let updatedAt: String
	let providers: [String: ProviderState]
	let settings: Settings

	static let providerOrder = ["claude", "codex"]
	static let providerTitles = ["claude": "Claude", "codex": "Codex"]

	var orderedProviders: [(id: String, title: String, state: ProviderState)] {
		Board.providerOrder.compactMap { id in
			guard let state = providers[id], !state.accounts.isEmpty else { return nil }
			return (id, Board.providerTitles[id] ?? id, state)
		}
	}
}

struct HistoryEntry: Decodable {
	let at: String
	let provider: String
	let from: String?
	let to: String
	let reason: String
}

/// A span of menu bar title text. Only a percentage carries colour, because a
/// number is the one part whose meaning changes at a glance.
struct TitleSpan: Decodable {
	let text: String
	let percent: Double?
}

enum Severity {
	case calm, warm, hot, spent

	init(percent: Double) {
		switch percent {
		case ..<60: self = .calm
		case ..<85: self = .warm
		case ..<97: self = .hot
		default: self = .spent
		}
	}

	var color: NSColor {
		switch self {
		case .calm: return NSColor(srgbRed: 0.35, green: 0.78, blue: 0.55, alpha: 1)
		case .warm: return NSColor(srgbRed: 0.87, green: 0.72, blue: 0.35, alpha: 1)
		case .hot: return NSColor(srgbRed: 0.91, green: 0.52, blue: 0.29, alpha: 1)
		case .spent: return NSColor(srgbRed: 0.89, green: 0.35, blue: 0.38, alpha: 1)
		}
	}
}

enum Countdown {
	/// Renders the gap to a reset the way a person says it out loud.
	static func describe(_ iso: String?, now: Date = Date()) -> String? {
		guard let iso, let target = parse(iso) else { return nil }
		let seconds = max(0, target.timeIntervalSince(now))
		let minutes = Int((seconds / 60).rounded())
		if minutes < 60 { return "\(minutes)m" }
		let hours = minutes / 60
		if hours < 24 { return "\(hours)h \(minutes % 60)m" }
		return "\(hours / 24)d \(hours % 24)h"
	}

	static func shortStamp(_ iso: String?) -> String {
		guard let iso, let date = parse(iso) else { return "" }
		let formatter = DateFormatter()
		formatter.dateFormat = Calendar.current.isDateInToday(date) ? "h:mm a" : "MMM d, h:mm a"
		return formatter.string(from: date)
	}

	private static let formatters: [ISO8601DateFormatter] = {
		let withFraction = ISO8601DateFormatter()
		withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		let plain = ISO8601DateFormatter()
		plain.formatOptions = [.withInternetDateTime]
		return [withFraction, plain]
	}()

	private static func parse(_ iso: String) -> Date? {
		for formatter in formatters where formatter.date(from: iso) != nil {
			return formatter.date(from: iso)
		}
		return nil
	}
}
