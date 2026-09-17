import AppKit

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

func sampleAccount(disabled: Bool = false, windows: Int = 2) -> Account {
	Account(
		id: "test",
		email: "someone@example.com",
		slot: 1,
		alias: nil,
		plan: "max",
		disabled: disabled,
		usage: UsageSnapshot(
			fetchedAt: "2026-09-16T12:00:00Z",
			windows: (0..<windows).map {
				UsageWindow(key: "w\($0)", label: "w\($0)", percent: Double($0) * 30, resetsAt: nil)
			},
			error: nil))
}

// MARK: - Rendering
//
// A view draws its own content first and its subviews after, so a highlight
// added as a subview silently paints over the row. That looks correct in code
// and is only visible on screen, which is exactly what this catches.

func renderRow(highlighted: Bool) -> NSBitmapImageRep? {
	let row = AccountRowView(account: sampleAccount(), isActive: true, width: 340)
	if highlighted { row.mouseEntered(with: NSEvent()) }
	row.layoutSubtreeIfNeeded()
	guard let rep = row.bitmapImageRepForCachingDisplay(in: row.bounds) else { return nil }
	row.cacheDisplay(in: row.bounds, to: rep)
	return rep
}

/// A row that drew its text has many distinct colours; one hidden behind a flat
/// highlight has very few.
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

print("rendering")
if let plain = renderRow(highlighted: false), let lit = renderRow(highlighted: true) {
	let plainColors = distinctColors(plain)
	let litColors = distinctColors(lit)
	check("a plain row draws its content", plainColors > 8, "\(plainColors) colours")
	check("a highlighted row still draws its content", litColors > 8, "\(litColors) colours")
	check(
		"the highlight does not swallow the row",
		Double(litColors) > Double(plainColors) * 0.4,
		"\(litColors) vs \(plainColors)")
} else {
	check("the row renders at all", false)
}

// MARK: - Clicking
//
// Giving a menu item a submenu makes AppKit replace the item's action with an
// internal one belonging to the menu. A row that reached for that action sent a
// selector to an object that does not implement it, and the app died mid-click.

print("clicking")

var clicked = 0
let live = NSMenuItem()
let liveRow = AccountRowView(
	account: sampleAccount(), isActive: false, width: 340, onClick: { clicked += 1 })
live.view = liveRow
// The submenu is what rewrote the action and caused the crash.
live.submenu = NSMenu()
let menu = NSMenu()
menu.addItem(live)

liveRow.mouseUp(with: NSEvent())
check("clicking a row runs the row's own handler", clicked == 1, "ran \(clicked) time(s)")
check(
	"the menu item's action is left alone",
	live.action == nil || live.action == Selector(("submenuAction:")),
	"action is \(live.action.map(NSStringFromSelector) ?? "none")")

// A row with no handler must not crash on a click, and must not cancel the
// menu it sits in either, since it has nothing to act on.
let inert = NSMenuItem()
let inertRow = AccountRowView(account: sampleAccount(disabled: true), isActive: false, width: 340)
inert.view = inertRow
inert.submenu = NSMenu()
let inertMenu = NSMenu()
inertMenu.addItem(inert)
inertRow.mouseUp(with: NSEvent())
check("a row with no handler survives a click", true)

// MARK: - Hovering
//
// A tooltip appearing over the row makes AppKit report the mouse as having
// left it, while the cursor has not moved. Taking those reports at face value
// made the highlight flicker as the cursor crossed the text.

print("hovering")
let hovered = AccountRowView(account: sampleAccount(), isActive: false, width: 340)
hovered.mouseEntered(with: NSEvent())
check("entering the row highlights it", hovered.isHighlighted)
hovered.isMouseInside = { true }
hovered.mouseExited(with: NSEvent())
check("a report of leaving while the cursor is still inside is ignored", hovered.isHighlighted)
hovered.isMouseInside = { false }
hovered.mouseExited(with: NSEvent())
check("really leaving the row clears the highlight", !hovered.isHighlighted)
hovered.mouseMoved(with: NSEvent())
check("moving inside the row highlights it, however the cursor got there", hovered.isHighlighted)
hovered.toolTip = "a tip"
check("the tooltip lives on the view the cursor is over, and nowhere else", hovered.toolTip == "a tip" && hovered.subviews.last?.toolTip == "a tip")

// MARK: - Sizing

print("sizing")
for count in 1...4 {
	let row = AccountRowView(account: sampleAccount(windows: count), isActive: false, width: 340)
	// Title line, one line per limit, and padding. Exact, so a change to the
	// drawing that is not matched in the height formula fails here.
	check(
		"a row with \(count) limit(s) is exactly as tall as its content",
		row.frame.height == 20 + CGFloat(count) * 17 + 10,
		"\(Int(row.frame.height))pt")
}
let errored = Account(
	id: "e", email: "e@example.com", slot: 1, alias: nil, plan: nil, disabled: false,
	usage: UsageSnapshot(fetchedAt: "2026-09-16T12:00:00Z", windows: [], error: "could not read usage"))
let erroredRow = AccountRowView(account: errored, isActive: false, width: 340)
check("a row with only an error reserves a line for it", erroredRow.frame.height == 20 + 17 + 10)

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
for provider in ["claude", "codex"] {
	if let mark = Logo.image(for: provider, in: logos) {
		check("the \(provider) mark loads as a template the height of the text", mark.isTemplate && mark.size.height == 12, "\(mark.size)")
	} else {
		check("the \(provider) mark loads", false)
	}
}
check("a service without a mark gets none rather than a crash", Logo.image(for: "other", in: logos) == nil)
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

exit(failures == 0 ? 0 : 1)
