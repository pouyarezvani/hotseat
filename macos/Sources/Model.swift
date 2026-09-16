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

	/// The names of the model-scoped limits this account reports, for the
	/// settings menu to offer as choices.
	var modelLimitNames: [String] {
		(usage?.windows ?? []).filter { $0.key.hasPrefix("weekly_scoped:") }.map(\.label)
	}
	var hasReadings: Bool { !(usage?.windows.isEmpty ?? true) }

	/// Room on the tightest counted limit, judged the same way the switcher
	/// judges it, or nil with no reading. Which model limits count comes from
	/// the same setting, so the header never promises a switch the switcher
	/// would refuse.
	func headroom(countingModels models: [String]) -> Double? {
		let wanted = Set(models.map { $0.lowercased() })
		let all = wanted.contains("all")
		let counted = (usage?.windows ?? []).filter { window in
			guard window.key.hasPrefix("weekly_scoped:") else { return true }
			return all || wanted.contains(window.label.lowercased())
		}
		guard let worst = counted.map(\.percent).max() else { return nil }
		return 100 - worst
	}
}

struct ProviderState: Decodable {
	let activeAccountId: String?
	let accounts: [Account]
}

/// Every field has a default, and decoding never fails on a missing one. A
/// settings key added or removed on the CLI side must not blank the whole
/// menu, which is what a strict decode of the enclosing board would do.
struct Settings: Decodable {
	var titleCompact = false
	var titleShowAccount = true
	var titlePercentage = "all"
	var titleShowModelLimits = true
	var titleShortenEmail = true
	var autoThresholdPercent = 90.0
	/// A limit of its own for the 5-hour window; 0 means the general one applies.
	var autoThresholdFiveHour = 0.0
	/// A limit of its own for the weekly window; 0 means the general one applies.
	var autoThresholdWeekly = 0.0
	var autoModelLimits: [String] = []

	private enum Keys: String, CodingKey {
		case titleCompact, titleShowAccount, titlePercentage, titleShowModelLimits
		case titleShortenEmail, autoThresholdPercent, autoThresholdFiveHour, autoThresholdWeekly, autoModelLimits
	}

	init() {}

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		titleCompact = try c.decodeIfPresent(Bool.self, forKey: .titleCompact) ?? titleCompact
		titleShowAccount = try c.decodeIfPresent(Bool.self, forKey: .titleShowAccount) ?? titleShowAccount
		titlePercentage = try c.decodeIfPresent(String.self, forKey: .titlePercentage) ?? titlePercentage
		titleShowModelLimits =
			try c.decodeIfPresent(Bool.self, forKey: .titleShowModelLimits) ?? titleShowModelLimits
		titleShortenEmail = try c.decodeIfPresent(Bool.self, forKey: .titleShortenEmail) ?? titleShortenEmail
		autoThresholdPercent =
			try c.decodeIfPresent(Double.self, forKey: .autoThresholdPercent) ?? autoThresholdPercent
		autoThresholdFiveHour =
			try c.decodeIfPresent(Double.self, forKey: .autoThresholdFiveHour) ?? autoThresholdFiveHour
		autoThresholdWeekly =
			try c.decodeIfPresent(Double.self, forKey: .autoThresholdWeekly) ?? autoThresholdWeekly
		autoModelLimits = try c.decodeIfPresent([String].self, forKey: .autoModelLimits) ?? autoModelLimits
	}
}

/// What one automatic pass did for one service, as the CLI reports it.
struct TickReport: Decodable {
	let provider: String
	let outcome: String
	let detail: String
	let to: String?
}

/// A notification worth showing, if the pass did something a person would
/// want to know about: a switch, or a switch that could not happen.
struct Notice: Equatable {
	let title: String
	let body: String

	/// The notice for a report, or nil when it is routine. The same notice
	/// twice in a row is nil the second time, so a stuck state is said once.
	static func from(_ report: TickReport, previous: Notice?) -> Notice? {
		let service = Board.providerTitles[report.provider] ?? report.provider
		let notice: Notice
		switch report.outcome {
		case "switched":
			notice = Notice(title: "\(service) switched to \(report.to ?? "another account")", body: report.detail)
		case "blocked":
			notice = Notice(title: "\(service) could not switch", body: report.detail)
		case "holding" where report.detail.hasPrefix("every other account is out of room"):
			notice = Notice(title: "\(service): every account is out of room", body: "The account in use has reached a limit and no other account has room left.")
		default:
			return nil
		}
		return notice == previous ? nil : notice
	}
}

struct Board: Decodable {
	let updatedAt: String
	let providers: [String: ProviderState]
	/// Missing settings fall back to defaults rather than failing the board.
	let settings: Settings

	private enum Keys: String, CodingKey { case updatedAt, providers, settings }

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		updatedAt = try c.decode(String.self, forKey: .updatedAt)
		providers = try c.decode([String: ProviderState].self, forKey: .providers)
		settings = try c.decodeIfPresent(Settings.self, forKey: .settings) ?? Settings()
	}

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
	let provider: String?
}

enum Severity {
	case calm, warm, hot, spent

	init(percent: Double) {
		// The same steps the terminal uses, so one number is never amber in one
		// place and red in the other.
		switch percent {
		case ..<65: self = .calm
		case ..<90: self = .warm
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
		// A reset already behind us means the next reading will show fresh
		// numbers; "0m" would read as if something were about to happen.
		guard target > now else { return nil }
		let seconds = target.timeIntervalSince(now)
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
