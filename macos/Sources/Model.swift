import AppKit

struct UsageWindow: Decodable {
	let key: String
	let label: String
	let percent: Double
	let resetsAt: String?
	/// Left off the board because it was asked to be; still counted toward
	/// what can be switched to.
	var hidden: Bool? = nil
	/// When this limit will be full at the pace it has been filling, if that is before it resets.
	var fullAt: String? = nil
	/// The last week of this limit as evenly spaced values, oldest first.
	var trend: [Double]? = nil
	/// How long this limit runs before it resets, when the service says: "5h", "week" or "month".
	var span: String? = nil
	/// When the window that resets at `resetsAt` began, when the service says.
	var startsAt: String? = nil
}

/// What a service's own status page says about it.
struct ServiceStatus: Decodable {
	let level: String
	let summary: String
	let url: String
	/// Whether the page lists this agent on its own, or speaks for a whole company.
	var scoped: Bool? = nil

	var isTrouble: Bool { level != "ok" }
	/// Trouble worth a tag: any in the agent's own entry, and only an outage on
	/// a page that covers a whole company, where a small issue is usually
	/// about some other product.
	var isShown: Bool { isTrouble && (scoped == true || level == "major" || level == "critical") }
}

/// A free reset of some of an account's limits, granted by the service, used
/// only when a person clicks it and says yes. Every field is optional and a
/// malformed one is dropped, so a reset never blanks the menu.
struct LimitReset: Decodable {
	var id: String = ""
	var title: String = "Limit reset"
	/// The limits it empties, by the names the board gives them.
	var clears: [String] = []
	/// A limit it leaves running, but gives back what the cleared ones used of it.
	var givesBack: String? = nil
	var expiresAt: String? = nil
	/// How many uses it has left, when it has more than one.
	var left: Int? = nil
	/// Why it cannot be used right now, when it cannot.
	var blocked: String? = nil
	/// How the service describes it.
	var detail: String? = nil
	/// Every reset on this line, when several that read the same are shown as one.
	var ids: [String] = []

	private enum Keys: String, CodingKey { case id, title, clears, givesBack, expiresAt, left, blocked, detail, ids }

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
		title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? title
		clears = (try? c.decodeIfPresent([String].self, forKey: .clears)) ?? []
		givesBack = try? c.decodeIfPresent(String.self, forKey: .givesBack)
		expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
		left = try? c.decodeIfPresent(Int.self, forKey: .left)
		blocked = try? c.decodeIfPresent(String.self, forKey: .blocked)
		detail = try? c.decodeIfPresent(String.self, forKey: .detail)
		ids = (try? c.decodeIfPresent([String].self, forKey: .ids)) ?? []
	}

	/// The resets this line stands for, by id, for a click to use whichever of them can be used.
	var allIds: [String] { (ids.isEmpty ? [id] : ids).filter { !$0.isEmpty } }

	/// Whether it has run out by `now`.
	func expired(at now: Date = Date()) -> Bool {
		guard let iso = expiresAt, let end = Countdown.date(iso) else { return false }
		return end <= now
	}

	/// Whether a click may use it: nothing blocks it, it has not run out, and it
	/// names which reset it is.
	var canUse: Bool { blocked == nil && !expired() && !allIds.isEmpty }

	/// What it empties, said the way a person reads it: "week + Fable".
	var clearsText: String? {
		var parts = clears
		if let givesBack { parts.append("its share of \(givesBack)") }
		return parts.isEmpty ? nil : parts.joined(separator: " + ")
	}
}

struct UsageSnapshot: Decodable {
	let fetchedAt: String
	let windows: [UsageWindow]
	let error: String?
	/// What a good read says when it brings no limits to show.
	var note: String? = nil
	/// "auth" when the service refused the login, which no switch can use.
	var errorKind: String? = nil
	/// The free limit resets the account holds, as last listed.
	var limitResets: [LimitReset]? = nil

	/// The limits that are drawn: every one but those asked to be left off.
	var shown: [UsageWindow] { windows.filter { $0.hidden != true } }
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
	var worstPercent: Double { usage?.shown.map(\.percent).max() ?? 0 }

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
	var activeAccountId: String?
	let accounts: [Account]

	/// How many accounts could be switched to right now, by the same rule the
	/// switcher applies, so the number never contradicts what choosing an
	/// account would do. The one in use is not somewhere to switch.
	func switchableCount(countingModels models: [String]) -> Int {
		accounts.filter { account in
			guard !account.disabled, account.id != activeAccountId else { return false }
			guard account.usage?.errorKind != "auth" else { return false }
			guard let room = account.headroom(countingModels: models) else { return false }
			return room >= Account.minimumUsableHeadroom
		}.count
	}
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
	/// Which services appear in the menu bar text. Never empty.
	var titleProviders: [String] = ["claude", "codex"]
	/// Which services hotseat adds by itself when it finds one signed in.
	var autoDetectProviders: [String] = Board.providerOrder

	private enum Keys: String, CodingKey {
		case titleCompact, titleShowAccount, titlePercentage, titleShowModelLimits
		case titleShortenEmail, autoThresholdPercent, autoThresholdFiveHour, autoThresholdWeekly, autoModelLimits
		case titleProviders, autoDetectProviders
	}

	init() {}

	/// These settings with one changed the way `hotseat config set` changes it,
	/// so the menu can show a change the moment it is asked for.
	func applying(_ key: String, _ value: String) -> Settings {
		var copy = self
		switch key {
		case "titleCompact": copy.titleCompact = value == "true"
		case "titleShowAccount": copy.titleShowAccount = value == "true"
		case "titleShowModelLimits": copy.titleShowModelLimits = value == "true"
		case "titleShortenEmail": copy.titleShortenEmail = value == "true"
		case "titlePercentage": copy.titlePercentage = value
		case "autoThresholdPercent": copy.autoThresholdPercent = Double(value) ?? copy.autoThresholdPercent
		case "autoThresholdFiveHour": copy.autoThresholdFiveHour = Double(value) ?? copy.autoThresholdFiveHour
		case "autoThresholdWeekly": copy.autoThresholdWeekly = Double(value) ?? copy.autoThresholdWeekly
		case "autoModelLimits":
			copy.autoModelLimits = value.split(separator: ",")
				.map { $0.trimmingCharacters(in: .whitespaces) }
				.filter { !$0.isEmpty }
		case "autoDetectProviders":
			copy.autoDetectProviders = value.split(separator: ",")
				.map { $0.trimmingCharacters(in: .whitespaces) }
				.filter { !$0.isEmpty }
		case "titleProviders":
			let chosen = value.split(separator: ",")
				.map { $0.trimmingCharacters(in: .whitespaces) }
				.filter { !$0.isEmpty }
			if !chosen.isEmpty { copy.titleProviders = chosen }
		default: break
		}
		return copy
	}

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
		autoDetectProviders =
			try c.decodeIfPresent([String].self, forKey: .autoDetectProviders) ?? autoDetectProviders
		let shown = try c.decodeIfPresent([String].self, forKey: .titleProviders) ?? titleProviders
		if !shown.isEmpty { titleProviders = shown }
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
	var providers: [String: ProviderState]
	/// Missing settings fall back to defaults rather than failing the board.
	var settings: Settings
	/// What each service's status page says; absent for one that has none.
	var services: [String: ServiceStatus] = [:]

	private enum Keys: String, CodingKey { case updatedAt, providers, settings, services }

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		updatedAt = try c.decode(String.self, forKey: .updatedAt)
		providers = try c.decode([String: ProviderState].self, forKey: .providers)
		settings = try c.decodeIfPresent(Settings.self, forKey: .settings) ?? Settings()
		services = (try? c.decodeIfPresent([String: ServiceStatus].self, forKey: .services)) ?? [:]
	}

	/// The board as it will look once a switch to this account lands. Shown the
	/// moment the account is clicked, so the menu bar answers at once; the real
	/// board replaces it when the switch finishes, or puts it back if it fails.
	/// The board with one setting changed, as it will read once the change is saved.
	func withSetting(_ key: String, _ value: String) -> Board {
		var copy = self
		copy.settings = settings.applying(key, value)
		return copy
	}

	func activating(provider: String, accountId: String) -> Board {
		guard let state = providers[provider],
			state.accounts.contains(where: { $0.id == accountId })
		else { return self }
		var copy = self
		copy.providers[provider]?.activeAccountId = accountId
		return copy
	}

	static let providerOrder = ["claude", "codex", "grok", "antigravity"]
	static let providerTitles = [
		"claude": "Claude", "codex": "Codex", "antigravity": "Antigravity", "grok": "Grok",
	]

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

/// Builds the menu bar title from the board, the same way the CLI's own
/// `title` command does, so the app can redraw the instant something changes
/// instead of asking the CLI and waiting. The CLI's tests and the app's checks
/// pin the same strings.
enum TitleBuilder {
	private static let dot = " \u{00B7} "
	private static let separator = " \u{2022} "

	static func spans(for board: Board) -> [TitleSpan] {
		let settings = board.settings
		var spans: [TitleSpan] = []
		for entry in board.orderedProviders where settings.titleProviders.contains(entry.id) {
			guard let active = entry.state.accounts.first(where: { $0.id == entry.state.activeAccountId })
			else { continue }
			if !spans.isEmpty {
				spans.append(TitleSpan(text: settings.titleCompact ? "  " : "   ", percent: nil, provider: nil))
			}
			let gap = settings.titleCompact ? " " : separator
			spans.append(TitleSpan(text: entry.title, percent: nil, provider: entry.id))
			if settings.titleShowAccount && !settings.titleCompact {
				let name = active.alias
					?? (settings.titleShortenEmail
						? String(active.email.split(separator: "@").first ?? Substring(active.email))
						: active.email)
				spans.append(TitleSpan(text: separator + name, percent: nil, provider: nil))
			}
			if settings.titlePercentage == "none" { continue }
			let all = active.usage?.shown ?? []
			let windows = settings.titleShowModelLimits
				? all : all.filter { !$0.key.hasPrefix("weekly_scoped:") }
			guard let worst = windows.map(\.percent).max() else { continue }
			spans.append(TitleSpan(text: gap, percent: nil, provider: nil))
			if settings.titlePercentage == "worst" || settings.titleCompact {
				spans.append(TitleSpan(text: "", percent: worst, provider: nil))
				continue
			}
			for (index, window) in windows.enumerated() {
				if index > 0 { spans.append(TitleSpan(text: dot, percent: nil, provider: nil)) }
				spans.append(TitleSpan(text: "", percent: window.percent, provider: nil))
			}
		}
		return spans
	}

	/// The title as plain text, which is what the checks compare.
	static func text(_ spans: [TitleSpan]) -> String {
		spans.map { span in
			span.percent.map { "\(Int($0.rounded()))%" } ?? span.text
		}.joined()
	}
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

/// Where a limit stands against the clock: how much of its window has gone by,
/// which is how full it would be if used evenly until it resets.
enum Pace {
	/// How long a window runs: from when it began, when the service says, else
	/// from what the service calls it, when that is clear.
	static func length(of window: UsageWindow) -> TimeInterval? {
		if let start = window.startsAt.flatMap(Countdown.date), let end = window.resetsAt.flatMap(Countdown.date),
			end > start
		{
			return end.timeIntervalSince(start)
		}
		let label = window.label.lowercased()
		switch window.span {
		case "5h": return 5 * 3600
		case "week": return 7 * 86_400
		case "month": return 30 * 86_400
		default: break
		}
		if window.key == "five_hour" || label == "5h" || label.hasSuffix(" 5h") { return 5 * 3600 }
		if window.key == "seven_day" || window.key.hasPrefix("weekly_scoped:") || label == "week"
			|| label.hasSuffix(" week")
		{
			return 7 * 86_400
		}
		if label == "day" || label == "daily" || label.hasSuffix(" day") || label.hasSuffix(" daily") { return 86_400 }
		if label == "month" { return 30 * 86_400 }
		return nil
	}

	/// The share of the window gone by, from 0 to 1, or nil when it cannot be told.
	static func gone(_ window: UsageWindow, now: Date = Date()) -> Double? {
		guard let length = length(of: window), let iso = window.resetsAt, let reset = Countdown.date(iso) else {
			return nil
		}
		let left = reset.timeIntervalSince(now)
		guard left > 0, left <= length else { return nil }
		return 1 - left / length
	}

	/// The bar's tooltip: how much is used against how much time has gone, in words.
	static func describe(_ window: UsageWindow, now: Date = Date()) -> String {
		let used = Int(window.percent.rounded())
		guard let gone = gone(window, now: now) else {
			let forecast = Countdown.describe(window.fullAt, now: now).map {
				" At the rate of the last few hours it would run out in about \($0), before it resets."
			}
			return "\(used)% of this limit is used." + (forecast ?? "")
		}
		let elapsed = Int((gone * 100).rounded())
		var text = "\(used)% used, with \(elapsed)% of the \(window.label) gone by. The tick marks where you would be using it evenly until it resets."
		text += window.percent <= gone * 100 ? " You are under that pace." : " You are ahead of that pace."
		if let left = Countdown.describe(window.fullAt, now: now) {
			text += " At the rate of the last few hours it would run out in about \(left), before it resets."
		}
		return text
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

	/// When a reset runs out: its date and the days left, or the hours left on its last day.
	static func expiry(_ iso: String?, now: Date = Date(), calendar: Calendar = .current) -> String? {
		guard let iso, let date = parse(iso), date > now else { return nil }
		let days =
			calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
		if days <= 0 { return "expires today (\(describe(iso, now: now) ?? "soon"))" }
		let formatter = DateFormatter()
		formatter.timeZone = calendar.timeZone
		formatter.dateFormat = "MMM d"
		return "expires \(formatter.string(from: date)) (\(days) day\(days == 1 ? "" : "s"))"
	}

	/// Whether a reset runs out within three days, which is worth a colour.
	static func expiresSoon(_ iso: String?, now: Date = Date()) -> Bool {
		guard let iso, let date = parse(iso) else { return false }
		return date > now && date.timeIntervalSince(now) < 3 * 86_400
	}

	/// The full moment a reset runs out, for a tooltip.
	static func longStamp(_ iso: String?) -> String? {
		guard let iso, let date = parse(iso) else { return nil }
		let formatter = DateFormatter()
		formatter.dateFormat = "MMM d, yyyy 'at' h:mm a zzz"
		return formatter.string(from: date)
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

	static func date(_ iso: String) -> Date? { parse(iso) }

	private static func parse(_ iso: String) -> Date? {
		for formatter in formatters where formatter.date(from: iso) != nil {
			return formatter.date(from: iso)
		}
		return nil
	}
}
