import AppKit

/// Renders a highlighted row off-screen and checks the text survived. A view
/// draws its subviews after its own content, so a highlight added as a subview
/// silently paints over the row. That failure looks fine in code and is only
/// visible on screen, which is exactly what this catches.
func renderRow(highlighted: Bool) -> NSBitmapImageRep? {
	let account = Account(
		id: "test",
		email: "someone@example.com",
		slot: 1,
		alias: nil,
		plan: "max",
		disabled: false,
		usage: UsageSnapshot(
			fetchedAt: "2026-09-16T12:00:00Z",
			windows: [
				UsageWindow(key: "five_hour", label: "5h", percent: 40, resetsAt: nil),
				UsageWindow(key: "seven_day", label: "week", percent: 70, resetsAt: nil),
			],
			error: nil))

	let row = AccountRowView(account: account, isActive: true, width: 340)
	if highlighted {
		row.mouseEntered(with: NSEvent())
	}
	row.layoutSubtreeIfNeeded()
	guard let rep = row.bitmapImageRepForCachingDisplay(in: row.bounds) else { return nil }
	row.cacheDisplay(in: row.bounds, to: rep)
	return rep
}

/// Counts how many distinct colours the row contains. A row that drew its text
/// has many; a row hidden behind a flat highlight has very few.
func distinctColors(_ rep: NSBitmapImageRep) -> Int {
	var seen = Set<Int>()
	let step = 2
	for x in stride(from: 0, to: rep.pixelsWide, by: step) {
		for y in stride(from: 0, to: rep.pixelsHigh, by: step) {
			guard let color = rep.colorAt(x: x, y: y) else { continue }
			let key =
				(Int(color.redComponent * 16) << 8) | (Int(color.greenComponent * 16) << 4)
				| Int(color.blueComponent * 16)
			seen.insert(key)
		}
	}
	return seen.count
}

var failures = 0

func check(_ name: String, _ passed: Bool, _ detail: String) {
	if passed {
		print("  ok    \(name)  \(detail)")
	} else {
		print("  FAIL  \(name)  \(detail)")
		failures += 1
	}
}

print("row rendering")

guard let plain = renderRow(highlighted: false), let lit = renderRow(highlighted: true) else {
	print("  FAIL  could not render the row")
	exit(1)
}

let plainColors = distinctColors(plain)
let litColors = distinctColors(lit)

check("plain row draws its content", plainColors > 8, "\(plainColors) distinct colours")
check("highlighted row still draws its content", litColors > 8, "\(litColors) distinct colours")
check(
	"the highlight does not swallow the row",
	Double(litColors) > Double(plainColors) * 0.4,
	"\(litColors) vs \(plainColors) when plain")

exit(failures == 0 ? 0 : 1)
