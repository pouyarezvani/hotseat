import AppKit
import SwiftUI

var failures = 0

func check(_ name: String, _ passed: Bool, _ detail: String = "") {
	let suffix = detail.isEmpty ? "" : "  \(detail)"
	if passed {
		print("  ok    \(name)\(suffix)")
	} else {
		print("  FAIL  \(name)\(suffix)")
		failures += 1
	}
}

// MARK: - Rendering
//
// The dropdown is drawn by the app itself, so a mistake in it shows as an empty
// or clipped window and nowhere else. It is drawn here off screen, at the size
// its content asks for, and saved as a picture when a folder is named.

func boardFor(_ json: String) -> Board {
	try! JSONDecoder().decode(Board.self, from: json.data(using: .utf8)!)
}

let panelBoard = boardFor("""
{"version":1,"updatedAt":"2026-09-16T12:00:00Z","services":{"codex":{"level":"major","summary":"Major outage: Elevated errors","url":"https://status.openai.com","checkedAt":"x","scoped":false},"grok":{"level":"minor","summary":"A small thing elsewhere","url":"u","checkedAt":"x","scoped":false},"claude":{"level":"ok","summary":"Claude Code is operational","url":"https://status.claude.com","checkedAt":"x"}},"providers":{
"claude":{"activeAccountId":"a","accounts":[
{"id":"a","email":"someone@example.com","slot":1,"plan":"max","disabled":false,"usage":{"fetchedAt":"2026-09-16T12:00:00Z","windows":[{"key":"five_hour","label":"5h","percent":13,"resetsAt":"2099-01-01T00:00:00Z","fullAt":"2098-12-31T22:00:00Z","trend":[0,2,5,5,9,13]},{"key":"weekly","label":"week","percent":97,"trend":[40,55,70,82,90,97]},{"key":"weekly_scoped:fable","label":"Fable","percent":70}],"limitResets":[{"id":"w","title":"Weekly reset","clears":["week","Fable"],"expiresAt":"2099-12-10T22:00:00.000Z","detail":"One full limit reset"},{"id":"f","title":"Fable reset","clears":["Fable"],"givesBack":"week","expiresAt":"2099-03-09T07:59:00.000Z"},{"id":"x","title":"Odd reset","clears":"not a list","left":"two","blocked":"cooling down after the last one"}]}},
{"id":"b","email":"other@example.com","slot":2,"disabled":false,"usage":{"fetchedAt":"2026-09-16T12:00:00Z","windows":[{"key":"weekly","label":"week","percent":4}]}},
{"id":"c","email":"off@example.com","slot":3,"disabled":true,"usage":{"fetchedAt":"2026-09-16T12:00:00Z","windows":[],"error":"could not read usage"}}]},
"codex":{"activeAccountId":"d","accounts":[
{"id":"d","email":"someone@example.com","slot":1,"disabled":false,"usage":{"fetchedAt":"2026-09-16T12:00:00Z","windows":[{"key":"primary","label":"week","percent":7}],"limitResets":[{"id":"c1","title":"Full reset","clears":["week"],"expiresAt":"2099-12-01T22:47:59.873Z"}]}}]},
"antigravity":{"activeAccountId":"e","accounts":[
{"id":"e","email":"someone@example.com","slot":1,"plan":"Google AI Pro","disabled":false,"usage":{"fetchedAt":"2026-09-16T12:00:00Z","windows":[{"key":"gemini-5h","label":"Gemini 5h","percent":0},{"key":"gemini-weekly","label":"Gemini week","percent":0.3},{"key":"3p-5h","label":"Claude and GPT 5h","percent":0},{"key":"3p-weekly","label":"Claude and GPT week","percent":0},{"key":"argon-weekly","label":"Gemini 4 Argon week","percent":4.2}]}}]}}}
""")

func renderPanel(_ configure: (PanelModel) -> Void, dark: Bool = true) -> NSBitmapImageRep? {
	let model = PanelModel()
	model.board = panelBoard
	model.maxPageHeight = 4000
	configure(model)
	let host = NSHostingView(rootView: PanelView(model: model, actions: PanelActions()))
	host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
	host.frame = NSRect(x: 0, y: 0, width: PanelView.width, height: 900)
	let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
	window.contentView = host
	// The scrolling part learns its content's height a pass after it first
	// lays out, so the run loop gets a turn before the size is asked for.
	for _ in 0..<3 {
		host.layoutSubtreeIfNeeded()
		RunLoop.main.run(until: Date().addingTimeInterval(0.05))
	}
	let size = host.fittingSize
	host.frame = NSRect(origin: .zero, size: size)
	window.setContentSize(size)
	host.layoutSubtreeIfNeeded()
	RunLoop.main.run(until: Date().addingTimeInterval(0.05))
	guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
	host.cacheDisplay(in: host.bounds, to: rep)
	return rep
}

/// A view that drew its text has many distinct colours; an empty one has few.
func distinctColors(_ rep: NSBitmapImageRep) -> Int {
	var seen = Set<Int>()
	for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
		for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
			guard let color = rep.colorAt(x: x, y: y) else { continue }
			seen.insert(
				(Int(color.redComponent * 16) << 8) | (Int(color.greenComponent * 16) << 4)
					| Int(color.blueComponent * 16))
		}
	}
	return seen.count
}

func save(_ rep: NSBitmapImageRep, as name: String) {
	guard let folder = ProcessInfo.processInfo.environment["HOTSEAT_RENDER_OUT"],
		let data = rep.representation(using: .png, properties: [:])
	else { return }
	try? data.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
}

print("rendering")
_ = NSApplication.shared
let pages: [(String, (PanelModel) -> Void, Bool)] = [
	("accounts", { _ in }, true),
	("accounts-light", { _ in }, false),
	("options", { $0.expanded = "claude|b" }, true),
	("trends", { $0.expanded = "claude|a" }, true),
	("settings", { $0.page = .settings }, true),
	("picker", { model in
		model.page = .settings
		model.openPicker = "autoThresholdPercent"
	}, true),
	("history", { model in
		model.page = .history
		model.history = [
			HistoryEntry(at: "2026-09-16T12:00:00Z", provider: "claude", from: "a@example.com", to: "b@example.com", reason: "auto")
		]
	}, true),
	("add", { $0.page = .add }, true),
	("empty", { $0.board = boardFor("{\"updatedAt\":\"2026-09-16T12:00:00Z\",\"providers\":{}}") }, true),
]
var heights: [String: CGFloat] = [:]
for (name, configure, dark) in pages {
	if let rep = renderPanel(configure, dark: dark) {
		save(rep, as: name)
		heights[name] = rep.size.height
		let colours = distinctColors(rep)
		check("the \(name) page draws its content", colours > 8, "\(colours) colours, \(Int(rep.size.width))x\(Int(rep.size.height))")
	} else {
		check("the \(name) page renders at all", false)
	}
}
check(
	"an open picker shows its choices under it, and a closed one takes no room for them",
	(heights["picker"] ?? 0) > (heights["settings"] ?? 0), "\(heights)")
check(
	"the dropdown is as tall as its content, not a fixed size",
	(heights["options"] ?? 0) > (heights["accounts"] ?? 0) && (heights["empty"] ?? 0) < (heights["accounts"] ?? 0),
	"\(heights)")

check(
	"an account's options show its limits' last week when there is one to show",
	(heights["trends"] ?? 0) > (heights["options"] ?? 0) - 60, "\(heights)")
let shownResets = panelBoard.providers["claude"]?.accounts.first?.usage?.limitResets ?? []
check("an account's resets are read with the board", shownResets.count == 3, "\(shownResets.count)")
check("a reset says what it clears", shownResets.first?.clearsText == "week + Fable", shownResets.first?.clearsText ?? "nil")
check("a reset that gives back part of a limit says so", shownResets.dropFirst().first?.clearsText == "Fable + its share of week")
check(
	"a line of several alike resets offers every one of them to a click",
	(try? JSONDecoder().decode(LimitReset.self, from: Data(#"{"id":"a","ids":["a","b"],"title":"Fable reset"}"#.utf8)))?
		.allIds == ["a", "b"])
check(
	"a reset with no id cannot be clicked",
	(try? JSONDecoder().decode(LimitReset.self, from: Data(#"{"title":"Weekly reset"}"#.utf8)))?.canUse == false)
let lapsed = try? JSONDecoder().decode(
	LimitReset.self, from: Data(#"{"id":"a","title":"Weekly reset","expiresAt":"2020-01-01T00:00:00Z"}"#.utf8))
check("a reset that has run out since the board was read cannot be used", lapsed?.canUse == false && lapsed?.expired() == true)
let current = try? JSONDecoder().decode(
	LimitReset.self, from: Data(#"{"id":"a","title":"Weekly reset","expiresAt":"2099-01-01T00:00:00Z"}"#.utf8))
check("one that has not can", current?.canUse == true && current?.expired() == false)
check(
	"a reset with a malformed field keeps the rest of it",
	shownResets.last?.title == "Odd reset" && shownResets.last?.clears == [] && shownResets.last?.left == nil
		&& shownResets.last?.blocked != nil)
check(
	"a control in a hovered card still shows its own hover",
	Theme.dark.rowHover != Theme.dark.cardHover && Theme.light.rowHover != Theme.light.cardHover)
let paceNow = Date(timeIntervalSince1970: 1_795_000_000)
let weekWindow = UsageWindow(
	key: "seven_day", label: "week", percent: 70,
	resetsAt: ISO8601DateFormatter().string(from: paceNow.addingTimeInterval(5 * 86_400)))
let paceGone = Pace.gone(weekWindow, now: paceNow) ?? -1
check("the pace tick sits at the share of the week gone by", abs(paceGone - 2.0 / 7.0) < 0.001, "\(paceGone)")
check(
	"a limit used faster than the clock says it is ahead of pace",
	Pace.describe(weekWindow, now: paceNow).contains("ahead of that pace"))
check(
	"a five-hour window is told by its name",
	Pace.length(of: UsageWindow(key: "gemini-5h", label: "Gemini 5h", percent: 0, resetsAt: nil)) == 5 * 3600)
check(
	"a window's own start sets its length",
	Pace.length(
		of: UsageWindow(
			key: "x", label: "limit", percent: 0, resetsAt: "2026-11-28T06:00:00Z", startsAt: "2026-11-27T06:00:00Z"))
		== 86_400)
check(
	"a daily window is told by its name",
	Pace.length(of: UsageWindow(key: "d", label: "Gemini day", percent: 0, resetsAt: nil)) == 86_400)
let spiking = UsageWindow(
	key: "seven_day", label: "week", percent: 20,
	resetsAt: ISO8601DateFormatter().string(from: paceNow.addingTimeInterval(3 * 86_400)),
	fullAt: ISO8601DateFormatter().string(from: paceNow.addingTimeInterval(8 * 3600)))
check(
	"a forecast shows even while under pace",
	Pace.describe(spiking, now: paceNow).contains("under that pace")
		&& Pace.describe(spiking, now: paceNow).contains("run out in about 8h"),
	Pace.describe(spiking, now: paceNow))
check(
	"a limit of unknown length draws no tick",
	Pace.gone(UsageWindow(key: "x", label: "limit", percent: 5, resetsAt: weekWindow.resetsAt), now: paceNow) == nil)
let expiryNow = Date(timeIntervalSince1970: 1_795_000_000)
var utc = Calendar(identifier: .gregorian)
utc.timeZone = TimeZone(identifier: "UTC")!
let later = { (hours: Double) in ISO8601DateFormatter().string(from: expiryNow.addingTimeInterval(hours * 3600)) }
check(
	"a reset days away names its date and the days left",
	Countdown.expiry("2026-12-10T22:00:00Z", now: expiryNow, calendar: utc) == "expires Dec 10 (22 days)",
	Countdown.expiry("2026-12-10T22:00:00Z", now: expiryNow, calendar: utc) ?? "nil")
check(
	"a reset months away is told apart by its days left, not its year",
	Countdown.expiry("2027-03-09T07:59:00Z", now: expiryNow, calendar: utc) == "expires Mar 9 (111 days)",
	Countdown.expiry("2027-03-09T07:59:00Z", now: expiryNow, calendar: utc) ?? "nil")
check(
	"a reset running out tomorrow says one day",
	Countdown.expiry(later(26), now: expiryNow, calendar: utc) == "expires Nov 19 (1 day)",
	Countdown.expiry(later(26), now: expiryNow, calendar: utc) ?? "nil")
check(
	"a reset running out today counts down its hours",
	Countdown.expiry(later(2), now: expiryNow, calendar: utc) == "expires today (2h 0m)",
	Countdown.expiry(later(2), now: expiryNow, calendar: utc) ?? "nil")
check("a reset already run out says nothing", Countdown.expiry("2020-01-01T00:00:00Z", now: expiryNow) == nil)
check("a status page's trouble is read with the board", panelBoard.services["codex"]?.isTrouble == true)
check("a service that is fine is not called trouble", panelBoard.services["claude"]?.isTrouble == false)
check("an outage on a page that covers a whole company is shown", panelBoard.services["codex"]?.isShown == true)
check(
	"a small issue on such a page is not: it is usually about another product",
	panelBoard.services["grok"]?.isShown == false)
check(
	"a board from an older command line, with no status pages in it, still decodes",
	boardFor("{\"updatedAt\":\"x\",\"providers\":{}}").services.isEmpty)

print("counting accounts to switch to")
check(
	"an account in use, one turned off and one with no reading are not somewhere to switch",
	panelBoard.providers["claude"]?.switchableCount(countingModels: []) == 1)
check(
	"a model limit that counts and is nearly full takes its account out",
	boardFor("""
	{"updatedAt":"x","providers":{"claude":{"activeAccountId":"a","accounts":[
	{"id":"a","email":"a@example.com","slot":1,"disabled":false},
	{"id":"b","email":"b@example.com","slot":2,"disabled":false,"usage":{"fetchedAt":"x","windows":[{"key":"weekly","label":"week","percent":4},{"key":"weekly_scoped:fable","label":"Fable","percent":99}]}}]}}}
	""").providers["claude"]?.switchableCount(countingModels: ["fable"]) == 0)

// MARK: - Decoding
//
// The board is decoded as one value, so a single non-optional field the CLI
// no longer sends fails the whole decode, and the menu silently shows "No
// accounts added yet" with every account still there. Settings must tolerate
// missing and extra keys.

print("decoding")
let sparse = """
{"version":1,"updatedAt":"2026-09-16T12:00:00Z","providers":{"claude":{"accounts":[]},"codex":{"accounts":[]}},"settings":{"titleCompact":true,"someFutureKey":42}}
""".data(using: .utf8)!
if let board = try? JSONDecoder().decode(Board.self, from: sparse) {
	check("a board decodes with settings keys missing and unknown", true)
	check("known settings keys are read", board.settings.titleCompact == true)
	check("missing settings keys take their defaults", board.settings.autoThresholdPercent == 90)
} else {
	check("a board decodes with settings keys missing and unknown", false)
}
let noSettings = """
{"version":1,"updatedAt":"2026-09-16T12:00:00Z","providers":{"claude":{"accounts":[]},"codex":{"accounts":[]}}}
""".data(using: .utf8)!
check("a board decodes with no settings at all", (try? JSONDecoder().decode(Board.self, from: noSettings)) != nil)

// MARK: - Marks
//
// The compact title shows each service's mark in place of its name. A mark
// that fails to load falls back to the name silently, so this is where a
// missing or broken file is caught.

print("marks")
let logos = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOTSEAT_LOGOS"] ?? "macos/Logos")
for provider in ["claude", "codex", "antigravity", "grok"] {
	if let mark = Logo.image(for: provider, in: logos) {
		check("the \(provider) mark loads as a template the height of the text", mark.isTemplate && mark.size.height == 12, "\(mark.size)")
	} else {
		check("the \(provider) mark loads", false)
	}
}
check("a service without a mark gets none rather than a crash", Logo.image(for: "other", in: logos) == nil)
if let colored = Logo.colorImage(for: "antigravity", in: logos) {
	check("a mark with colours of its own keeps them: it is not a template", !colored.isTemplate && colored.size.width > 0)
} else {
	check("the Antigravity mark loads in its own colours", false)
}
check("a mark with one colour has no picture of its own", Logo.colorImage(for: "codex", in: logos) == nil)
if let mark = Logo.image(for: "claude", in: logos) {
	let painted = Logo.tinted(mark, with: .white, appearance: NSAppearance(named: .darkAqua))
	if let rep = painted.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) {
		var lit = 0
		for x in 0..<rep.pixelsWide {
			for y in 0..<rep.pixelsHigh {
				guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
				if c.alphaComponent > 0.5, c.redComponent > 0.9, c.greenComponent > 0.9, c.blueComponent > 0.9 { lit += 1 }
			}
		}
		check("a tinted mark is painted in the colour asked for", lit > 20, "\(lit) white pixels")
	} else {
		check("a tinted mark can be read back", false)
	}
}

// MARK: - Notices
//
// A pass that switched, or could not, is worth a notification; a routine
// hold is not, and the same stuck state is said once rather than every minute.

print("notices")
let switched = TickReport(provider: "claude", outcome: "switched", detail: "switched to b@example.com", to: "b@example.com")
let first = Notice.from(switched, previous: nil)
check("a switch is announced", first?.title == "Claude switched to b@example.com", first?.title ?? "nil")
check("the same switch is not announced twice", Notice.from(switched, previous: first) == nil)
let hold = TickReport(provider: "claude", outcome: "holding", detail: "at 50%, below the 90% limit", to: nil)
check("a routine hold is not announced", Notice.from(hold, previous: nil) == nil)
let spent = TickReport(provider: "codex", outcome: "holding", detail: "every other account is out of room too", to: nil)
check("every account out of room is announced", Notice.from(spent, previous: nil)?.title == "Codex: every account is out of room")
let blocked = TickReport(provider: "claude", outcome: "blocked", detail: "b@example.com: no saved login", to: nil)
check("a switch that could not happen is announced", Notice.from(blocked, previous: nil)?.title == "Claude could not switch")
let decoded = try? JSONDecoder().decode(
	Settings.self, from: "{\"autoThresholdFiveHour\": 95}".data(using: .utf8)!)
check("the per-window limits decode with defaults", decoded?.autoThresholdFiveHour == 95 && decoded?.autoThresholdWeekly == 0)

// MARK: - Title
//
// The app builds its own title from the board, so a click can show in the
// menu bar at once instead of after a round trip to the CLI. The strings are
// the same ones the CLI's own title tests pin, so the two cannot drift.

print("title")
func boardFixture(_ settings: String) -> Board {
	let json = """
	{"version":1,"updatedAt":"2026-09-16T12:00:00Z","settings":\(settings),"providers":{
	"claude":{"activeAccountId":"a","accounts":[
	{"id":"a","email":"pouya@example.com","slot":1,"disabled":false,"usage":{"fetchedAt":"x","windows":[
	{"key":"five_hour","label":"5h","percent":32},{"key":"seven_day","label":"week","percent":8},{"key":"weekly_scoped:fable","label":"Fable","percent":13}]}},
	{"id":"a2","email":"other@example.com","alias":"work","slot":2,"disabled":false,"usage":{"fetchedAt":"x","windows":[
	{"key":"five_hour","label":"5h","percent":5}]}}]},
	"codex":{"activeAccountId":"b","accounts":[
	{"id":"b","email":"someone@example.com","slot":1,"disabled":false,"usage":{"fetchedAt":"x","windows":[
	{"key":"secondary","label":"week","percent":69}]}}]}}}
	"""
	return try! JSONDecoder().decode(Board.self, from: json.data(using: .utf8)!)
}
func titleOf(_ board: Board) -> String { TitleBuilder.text(TitleBuilder.spans(for: board)) }

check("the full title", titleOf(boardFixture("{}")) == "Claude • pouya • 32% · 8% · 13%   Codex • someone • 69%", titleOf(boardFixture("{}")))
check("the compact title", titleOf(boardFixture("{\"titleCompact\":true}")) == "Claude 32%  Codex 69%", titleOf(boardFixture("{\"titleCompact\":true}")))
check("the fullest limit only", titleOf(boardFixture("{\"titlePercentage\":\"worst\"}")) == "Claude • pouya • 32%   Codex • someone • 69%")
check("no percentages", titleOf(boardFixture("{\"titlePercentage\":\"none\"}")) == "Claude • pouya   Codex • someone")
check("without model limits", titleOf(boardFixture("{\"titleShowModelLimits\":false}")) == "Claude • pouya • 32% · 8%   Codex • someone • 69%")
check("the whole address when asked", titleOf(boardFixture("{\"titleShortenEmail\":false}")).hasPrefix("Claude • pouya@example.com"))
let afterClick = boardFixture("{}").activating(provider: "claude", accountId: "a2")
check("a click shows in the title at once, by the name you gave it", titleOf(afterClick) == "Claude • work • 5%   Codex • someone • 69%", titleOf(afterClick))
check("a click on an account that is not there changes nothing", titleOf(boardFixture("{}").activating(provider: "claude", accountId: "nope")) == titleOf(boardFixture("{}")))
let marked = TitleBuilder.spans(for: boardFixture("{}")).compactMap(\.provider)
check("the service spans are marked, so the compact title can show their marks", marked == ["claude", "codex"])

// MARK: - Commands that fail
//
// What a failed command says is what the person reads in the alert. A command
// cut off for taking too long must say so, not replay whatever it printed.

// A setting changed from the menu shows at once, so a second click reverses
// it rather than asking for the same value again.
print("changing a setting")
check("a switched-on setting reads as on at once", Settings().applying("titleCompact", "true").titleCompact)
check(
	"a switched-off setting reads as off at once",
	!Settings().applying("titleShowAccount", "false").titleShowAccount)
check("a choice reads as chosen at once", Settings().applying("titlePercentage", "worst").titlePercentage == "worst")
check(
	"a limit reads as set at once", Settings().applying("autoThresholdPercent", "85").autoThresholdPercent == 85)
check(
	"the model limits counted read as set at once",
	Settings().applying("autoModelLimits", "fable, opus").autoModelLimits == ["fable", "opus"])
check("clearing the model limits reads as none at once", Settings().applying("autoModelLimits", "").autoModelLimits.isEmpty)

print("failing commands")
let slow = Runner(executable: "/bin/sleep")
check("a command that runs too long is cut off", slow.run(["5"], timeout: 0.5) == nil)
check("and says it did not finish in time", slow.timedOut && slow.lastError.contains("did not finish"), slow.lastError)
let noisy = Runner(executable: "/bin/sh")
check("a command that fails is reported as failed", noisy.run(["-c", "echo 'Opening browser' >&2; echo 'step two' >&2; echo '\u{2717} the sign-in ended with status 1' >&2; exit 1"]) == nil)
check("and what it says is its own last line, not everything it printed", noisy.lastError == "the sign-in ended with status 1", noisy.lastError)
check("a failure that is not a timeout is not called one", !noisy.timedOut)
check(
	"a command cut off is not said to have changed nothing, since it may have",
	slow.lastError.contains("may have"), slow.lastError)

let chatty = Runner(executable: "/bin/sh")
let chattyOut = chatty.run(
	["-c", "head -c 1048576 /dev/zero | tr '\\0' x >&2; echo done"], timeout: 10)
check(
	"a command that says a great deal on its error stream still finishes",
	chattyOut.flatMap { String(data: $0, encoding: .utf8) } == "done\n" && !chatty.timedOut,
	chatty.lastError)

let familyFile = NSTemporaryDirectory() + "hotseat-runner-family-\(UUID().uuidString)"
let family = Runner(executable: "/bin/sh")
let familyStarted = Date()
check(
	"a command that ignores being asked to stop is stopped, with what it started",
	family.run(
		["-c", "trap '' TERM; (trap '' TERM; exec sleep 12) & echo $! > \(familyFile); sleep 20"],
		timeout: 0.5) == nil && family.timedOut)
check(
	"and soon after its time is up, though what it started holds its output open",
	Date().timeIntervalSince(familyStarted) < 8, String(Date().timeIntervalSince(familyStarted)))
usleep(300_000)
let leftBehind = Int32(
	(try? String(contentsOfFile: familyFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
check("leaving nothing it started running", leftBehind > 0 && kill(leftBehind, 0) != 0, String(leftBehind))
if leftBehind > 0 { kill(leftBehind, SIGKILL) }
try? FileManager.default.removeItem(atPath: familyFile)

// The CLI the app runs: beside the app first, as an install lays them out,
// then the checkout the app was built in, then the usual install folders.
let home = URL(fileURLWithPath: "/Users/someone")
let installed = Runner.candidates(bundle: URL(fileURLWithPath: "/opt/tools/Hotseat.app"), home: home)
check(
	"a released app runs the CLI it carries first",
	installed.first == "/opt/tools/Hotseat.app/Contents/Helpers/hotseat", installed.first ?? "none")
check(
	"an app installed beside its CLI runs that CLI next",
	installed.dropFirst().first == "/opt/tools/hotseat", installed.dropFirst().first ?? "none")

print("command line link")
let linkHome = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("hotseat-link-\(getpid())")
let linkFiles = FileManager.default
try? linkFiles.removeItem(at: linkHome)
let installedApp = linkHome.appendingPathComponent("Applications/Hotseat.app")
let carriedCLI = CommandLineLink.carried(in: installedApp)
try! linkFiles.createDirectory(at: carriedCLI.deletingLastPathComponent(), withIntermediateDirectories: true)
linkFiles.createFile(atPath: carriedCLI.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
let cliLink = linkHome.appendingPathComponent(".local/bin/hotseat")
check(
	"an installed app links the CLI it carries",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == cliLink.path
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == carriedCLI.path)
check("and leaves a link that already points there", CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil)
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: "/src/hotseat/dist/hotseat")
check(
	"a link to nothing is pointed at the installed one",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == cliLink.path
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == carriedCLI.path)
try! linkFiles.removeItem(at: cliLink)
let ownBuild = linkHome.appendingPathComponent("src/hotseat/dist/hotseat")
try! linkFiles.createDirectory(at: ownBuild.deletingLastPathComponent(), withIntermediateDirectories: true)
linkFiles.createFile(atPath: ownBuild.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: ownBuild.path)
check(
	"a link to a build of your own that exists is left as it is",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == ownBuild.path)
let realDeep = linkHome.appendingPathComponent("real/deep")
try! linkFiles.createDirectory(at: realDeep, withIntermediateDirectories: true)
try! linkFiles.createSymbolicLink(atPath: linkHome.appendingPathComponent("via").path, withDestinationPath: realDeep.path)
linkFiles.createFile(
	atPath: linkHome.appendingPathComponent("real/mine").path, contents: Data("#!/bin/sh\n".utf8),
	attributes: [.posixPermissions: 0o755])
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: "../../via/../mine")
check(
	"a relative link through a linked folder is followed as the system follows it",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == "../../via/../mine")
func fakeApp(_ name: String, id: String) -> URL {
	let app = linkHome.appendingPathComponent("Elsewhere/\(name).app")
	let helper = CommandLineLink.carried(in: app)
	try! linkFiles.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
	linkFiles.createFile(atPath: helper.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
	let plist: [String: Any] = ["CFBundleIdentifier": id, "CFBundleExecutable": "x", "CFBundlePackageType": "APPL"]
	try! PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
		.write(to: app.appendingPathComponent("Contents/Info.plist"))
	return helper
}
let unrelated = fakeApp("Other", id: "com.example.other")
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: unrelated.path)
check(
	"a link to a helper inside some other app is left as it is",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == unrelated.path)
let hidden = linkHome.appendingPathComponent("Locked/inner/hotseat")
try! linkFiles.createDirectory(at: hidden.deletingLastPathComponent(), withIntermediateDirectories: true)
linkFiles.createFile(atPath: hidden.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
try! linkFiles.setAttributes([.posixPermissions: 0o000], ofItemAtPath: hidden.deletingLastPathComponent().path)
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: hidden.path)
check(
	"a link to something that cannot be looked at is not taken for a link to nothing",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == hidden.path)
try! linkFiles.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hidden.deletingLastPathComponent().path)
let olderCopy = fakeApp("Old Hotseat", id: "dev.hotseat.menubar")
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: olderCopy.path)
check(
	"a link to another copy of the app's CLI is pointed at this one",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == cliLink.path
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == carriedCLI.path)
try! linkFiles.removeItem(at: cliLink)
linkFiles.createFile(atPath: cliLink.path, contents: Data("mine".utf8))
check(
	"a CLI that is a file of its own is never replaced",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == nil
		&& (try? String(contentsOf: cliLink, encoding: .utf8)) == "mine")
try! linkFiles.removeItem(at: cliLink)
check(
	"a link put in place where there was none is the installed one, with nothing left beside it",
	CommandLineLink.ensure(bundle: installedApp, home: linkHome) == cliLink.path
		&& (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == carriedCLI.path
		&& (try? linkFiles.contentsOfDirectory(atPath: cliLink.deletingLastPathComponent().path))?.count == 1)
try! linkFiles.removeItem(at: cliLink)
try! linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: "/src/hotseat/dist/hotseat")
var swaps = 0
let raced = CommandLineLink.ensure(bundle: installedApp, home: linkHome) { from, to, flags in
	swaps += 1
	if swaps == 1 {
		try? linkFiles.removeItem(at: cliLink)
		linkFiles.createFile(atPath: cliLink.path, contents: Data("mine".utf8))
		return renamex_np(from, to, flags)
	}
	return -1
}
let leftBeside = (try? linkFiles.contentsOfDirectory(atPath: cliLink.deletingLastPathComponent().path)) ?? []
check(
	"a file put in place of the link during the swap is kept, even when it cannot be swapped back",
	raced == nil
		&& leftBeside.contains { name in
			(try? String(contentsOf: cliLink.deletingLastPathComponent().appendingPathComponent(name), encoding: .utf8))
				== "mine"
		},
	leftBeside.joined(separator: ", "))
for name in leftBeside {
	try? linkFiles.removeItem(at: cliLink.deletingLastPathComponent().appendingPathComponent(name))
}
try? linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: "/src/hotseat/dist/hotseat")
var turns = 0
let twice = CommandLineLink.ensure(bundle: installedApp, home: linkHome) { from, to, flags in
	turns += 1
	if turns <= 2 {
		try? linkFiles.removeItem(at: cliLink)
		linkFiles.createFile(atPath: cliLink.path, contents: Data("mine \(turns)".utf8))
	}
	return renamex_np(from, to, flags)
}
let afterTwice = (try? linkFiles.contentsOfDirectory(atPath: cliLink.deletingLastPathComponent().path)) ?? []
let contents = afterTwice.compactMap { name in
	try? String(contentsOf: cliLink.deletingLastPathComponent().appendingPathComponent(name), encoding: .utf8)
}
check(
	"files put in place of the link before each swap are both kept, the newest where the link was",
	twice == nil && contents.contains("mine 1") && contents.contains("mine 2")
		&& (try? String(contentsOf: cliLink, encoding: .utf8)) == "mine 2",
	contents.joined(separator: ", "))
for name in afterTwice {
	try? linkFiles.removeItem(at: cliLink.deletingLastPathComponent().appendingPathComponent(name))
}
try? linkFiles.removeItem(at: cliLink)
try? linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: "/nowhere/hotseat")
let retargeted = CommandLineLink.ensure(bundle: installedApp, home: linkHome) { from, to, flags in
	if flags == UInt32(RENAME_SWAP), (try? linkFiles.destinationOfSymbolicLink(atPath: to)) == "/nowhere/hotseat" {
		try? linkFiles.removeItem(at: cliLink)
		try? linkFiles.createSymbolicLink(atPath: cliLink.path, withDestinationPath: ownBuild.path)
	}
	return renamex_np(from, to, flags)
}
check(
	"a link turned to a build of your own during the swap is put back",
	retargeted == nil && (try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) == ownBuild.path,
	(try? linkFiles.destinationOfSymbolicLink(atPath: cliLink.path)) ?? "none")
for name in (try? linkFiles.contentsOfDirectory(atPath: cliLink.deletingLastPathComponent().path)) ?? [] {
	try? linkFiles.removeItem(at: cliLink.deletingLastPathComponent().appendingPathComponent(name))
}
let strayApp = linkHome.appendingPathComponent("Downloads/Hotseat.app")
try! linkFiles.createDirectory(
	at: CommandLineLink.carried(in: strayApp).deletingLastPathComponent(), withIntermediateDirectories: true)
linkFiles.createFile(
	atPath: CommandLineLink.carried(in: strayApp).path, contents: Data("#!/bin/sh\n".utf8),
	attributes: [.posixPermissions: 0o755])
try? linkFiles.removeItem(at: cliLink)
check(
	"an app run from outside Applications links nothing",
	CommandLineLink.ensure(bundle: strayApp, home: linkHome) == nil && !linkFiles.fileExists(atPath: cliLink.path))
try? linkFiles.removeItem(at: linkHome)
let fromCheckout = Runner.candidates(
	bundle: URL(fileURLWithPath: "/src/hotseat/macos/build/Hotseat.app"), home: home)
check(
	"an app built in a checkout runs that checkout's CLI before any installed one",
	(fromCheckout.firstIndex(of: "/src/hotseat/dist/hotseat") ?? Int.max)
		< (fromCheckout.firstIndex(of: "/Users/someone/.local/bin/hotseat") ?? -1),
	fromCheckout.joined(separator: ", "))

exit(failures == 0 ? 0 : 1)
