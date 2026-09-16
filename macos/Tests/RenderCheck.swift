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

var inertClicked = 0
let inert = NSMenuItem()
let inertRow = AccountRowView(account: sampleAccount(disabled: true), isActive: false, width: 340)
inert.view = inertRow
inert.submenu = NSMenu()
NSMenu().addItem(inert)
inertRow.mouseUp(with: NSEvent())
check("a row with no handler does nothing at all", inertClicked == 0)
inertClicked += 0

// MARK: - Sizing

print("sizing")
for count in 1...4 {
	let row = AccountRowView(account: sampleAccount(windows: count), isActive: false, width: 340)
	check(
		"a row with \(count) limit(s) is tall enough for them",
		row.frame.height >= CGFloat(count) * 17,
		"\(Int(row.frame.height))pt")
}

exit(failures == 0 ? 0 : 1)
