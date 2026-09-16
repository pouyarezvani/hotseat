import AppKit

/// The menu is built around one idea: an account row IS the switch. Clicking a
/// row switches to that account, so the common case needs no verb and no
/// submenu. Everything else lives below the separator.
/// Rebuilds a submenu each time it opens. Without this a submenu is built once
/// with the parent and keeps showing the state from that moment, so a setting
/// toggled inside it still reads the old way when reopened.
final class LiveSubmenu: NSObject, NSMenuDelegate {
	private let build: (NSMenu) -> Void

	init(build: @escaping (NSMenu) -> Void) {
		self.build = build
	}

	func menuNeedsUpdate(_ menu: NSMenu) {
		menu.removeAllItems()
		build(menu)
	}
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
	private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
	private let runner = Runner()
	private var board: Board?
	private var timer: Timer?
	private var isBusy = false
	/// Held so the submenu delegates are not released while their menus live.
	private var liveSubmenus: [LiveSubmenu] = []
	private var watcher: DispatchSourceFileSystemObject?
	private var watchedDescriptor: CInt = -1
	private var pendingReload: DispatchWorkItem?
	private static let menuWidth: CGFloat = 340

	func applicationDidFinishLaunching(_ notification: Notification) {
		let menu = NSMenu()
		menu.delegate = self
		menu.autoenablesItems = false
		statusItem.menu = menu
		refresh()
		watchState()
	}

	/// Watches the state file so a change made anywhere, such as adding an account
	/// in a terminal, shows here at once rather than at the next scheduled read.
	private func watchState() {
		let home =
			ProcessInfo.processInfo.environment["HOTSEAT_HOME"]
			?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hotseat").path
		let path = (home as NSString).appendingPathComponent("state.json")
		FileManager.default.createFile(atPath: path, contents: nil)
		let descriptor = open(path, O_EVTONLY)
		guard descriptor >= 0 else { return }
		watchedDescriptor = descriptor
		let source = DispatchSource.makeFileSystemObjectSource(
			fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
		source.setEventHandler { [weak self] in
			guard let self else { return }
			// An atomic write replaces the file, so the old descriptor stops
			// receiving events. Re-arm on the new one.
			if source.data.contains(.delete) || source.data.contains(.rename) {
				self.stopWatching()
				DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.watchState() }
			}
			// A burst of writes is one change. Collapsing them also keeps a
			// re-arm from counting as a second event.
			self.pendingReload?.cancel()
			let reload = DispatchWorkItem { [weak self] in self?.refresh() }
			self.pendingReload = reload
			DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: reload)
		}
		source.setCancelHandler { [weak self] in
			guard let self, self.watchedDescriptor >= 0 else { return }
			close(self.watchedDescriptor)
			self.watchedDescriptor = -1
		}
		source.resume()
		watcher = source
	}

	private func stopWatching() {
		watcher?.cancel()
		watcher = nil
	}

	// MARK: - Data

	/// Each refresh is also a switching pass. The app is what keeps the accounts
	/// rotating, so a user who has it running needs nothing else.
	@objc private func refresh() {
		guard !isBusy else { return }
		isBusy = true
		DispatchQueue.global(qos: .utility).async { [weak self] in
			guard let self else { return }
			self.runner.run(["auto", "--once"])
			let loaded = self.runner.board()
			let spans = self.runner.title()
			DispatchQueue.main.async {
				self.isBusy = false
				self.board = loaded
				self.render(spans: spans)
				self.rescheduleTimer()
			}
		}
	}

	private func rescheduleTimer() {
		let seconds = board?.settings.refreshIntervalSeconds ?? 180
		guard timer?.timeInterval != seconds else { return }
		timer?.invalidate()
		let timer = Timer.scheduledTimer(
			withTimeInterval: seconds, repeats: true
		) { [weak self] _ in self?.refresh() }
		timer.tolerance = seconds / 6
		self.timer = timer
	}

	/// Runs a CLI action, then refreshes, so the menu never shows a stale seat.
	private func perform(_ arguments: [String]) {
		guard !isBusy else { return }
		isBusy = true
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			self.runner.run(arguments)
			DispatchQueue.main.async {
				self.isBusy = false
				self.refresh()
			}
		}
	}

	// MARK: - Title

	private func render(spans: [TitleSpan]) {
		guard let button = statusItem.button else { return }
		guard !spans.isEmpty else {
			button.attributedTitle = NSAttributedString(
				string: "hotseat",
				attributes: [
					.foregroundColor: NSColor.tertiaryLabelColor,
					.font: NSFont.systemFont(ofSize: 12, weight: .medium),
				])
			return
		}
		let title = NSMutableAttributedString()
		for span in spans {
			if let percent = span.percent {
				title.append(
					NSAttributedString(
						string: "\(Int(percent.rounded()))%",
						attributes: [
							.foregroundColor: Severity(percent: percent).color,
							.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
						]))
			} else {
				title.append(
					NSAttributedString(
						string: span.text,
						attributes: [
							.foregroundColor: NSColor.labelColor,
							.font: NSFont.systemFont(ofSize: 12, weight: .medium),
						]))
			}
		}
		button.attributedTitle = title
	}

	// MARK: - Menu

	private func live(_ title: String, _ build: @escaping (NSMenu) -> Void) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		let submenu = NSMenu(title: title)
		submenu.autoenablesItems = false
		let delegate = LiveSubmenu(build: build)
		liveSubmenus.append(delegate)
		submenu.delegate = delegate
		item.submenu = submenu
		return item
	}

	func menuNeedsUpdate(_ menu: NSMenu) {
		menu.removeAllItems()
		liveSubmenus.removeAll()
		guard let board, !board.orderedProviders.isEmpty else {
			menu.addItem(caption("No accounts added yet"))
			menu.addItem(
				action("Add the current Claude account", #selector(addClaude), enabled: true))
			menu.addItem(
				action("Add the current Codex account", #selector(addCodex), enabled: true))
			menu.addItem(.separator())
			appendFooter(to: menu)
			return
		}
		for entry in board.orderedProviders {
			menu.addItem(providerHeader(entry.title, state: entry.state, providerId: entry.id))
			for account in entry.state.accounts {
				menu.addItem(accountItem(account, entry: entry))
			}
			menu.addItem(.separator())
		}
		appendFooter(to: menu)
	}

	private func providerHeader(_ title: String, state: ProviderState, providerId: String)
		-> NSMenuItem
	{
		// Counts only accounts that could actually be switched to, using the same
		// rule the switcher applies, so the number never contradicts what
		// choosing an account would do. The one in use is excluded, because it is
		// not somewhere to switch.
		let spare = state.accounts.filter {
			!$0.disabled && $0.id != state.activeAccountId
				&& $0.headroom >= Account.minimumUsableHeadroom
		}.count
		let item = NSMenuItem()
		let text = NSMutableAttributedString(
			string: title,
			attributes: [
				.font: NSFont.systemFont(ofSize: 11, weight: .semibold),
				.foregroundColor: NSColor.secondaryLabelColor,
			])
		text.append(
			NSAttributedString(
				string: spare == 0 ? "   nothing to switch to" : "   \(spare) to switch to",
				attributes: [
					.font: NSFont.systemFont(ofSize: 11),
					.foregroundColor: NSColor.tertiaryLabelColor,
				]))
		item.attributedTitle = text
		item.isEnabled = false
		return item
	}

	private func accountItem(_ account: Account, entry: (id: String, title: String, state: ProviderState))
		-> NSMenuItem
	{
		let item = NSMenuItem()
		let isActive = account.id == entry.state.activeAccountId
		let canSwitch = !isActive && !account.disabled
		let provider = entry.id
		let slot = String(account.slot)
		item.view = AccountRowView(
			account: account,
			isActive: isActive,
			width: Self.menuWidth,
			onClick: canSwitch ? { [weak self] in self?.perform(["switch", provider, slot]) } : nil)
		item.submenu = accountMenu(account, providerId: entry.id, isActive: isActive)
		return item
	}

	/// Per-account actions hang off the row itself, rather than repeating the
	/// whole account list once per verb the way a flat menu has to.
	private func accountMenu(_ account: Account, providerId: String, isActive: Bool) -> NSMenu {
		let menu = NSMenu()
		menu.autoenablesItems = false
		let selector = "\(providerId)|\(account.slot)"
		if !isActive && !account.disabled {
			menu.addItem(bound("Switch to this account", #selector(seatSelector(_:)), selector))
			menu.addItem(.separator())
		}
		menu.addItem(
			bound(
				account.disabled ? "Enable" : "Disable",
				account.disabled ? #selector(enableSelector(_:)) : #selector(disableSelector(_:)),
				selector))
		menu.addItem(bound("Update saved login", #selector(captureSelector(_:)), selector))
		menu.addItem(.separator())
		menu.addItem(bound("Remove account", #selector(removeSelector(_:)), selector))
		if let plan = account.plan {
			menu.addItem(.separator())
			menu.addItem(caption("Plan: \(plan)"))
		}
		if let fetched = account.usage?.fetchedAt {
			menu.addItem(caption("Checked at \(Countdown.shortStamp(fetched))"))
		}
		return menu
	}

	private func appendFooter(to menu: NSMenu) {
		menu.addItem(action("Switch to the most available", #selector(switchToBest), enabled: true, key: "b"))

		menu.addItem(
			live("Add an account") { [weak self] submenu in
				guard let self else { return }
				submenu.addItem(
					self.action(
						"Sign in to a different account\u{2026}", #selector(self.addFromToken),
						enabled: true))
				submenu.addItem(.separator())
				submenu.addItem(self.caption("Or save the login already on this machine"))
				submenu.addItem(self.action("Claude", #selector(self.addClaude), enabled: true))
				submenu.addItem(self.action("Codex", #selector(self.addCodex), enabled: true))
				submenu.addItem(.separator())
				submenu.addItem(self.caption("Adding never signs anything out."))
			})

		menu.addItem(live("Recent switches") { [weak self] submenu in self?.fillHistory(submenu) })
		menu.addItem(live("Settings") { [weak self] submenu in self?.fillSettings(submenu) })

		menu.addItem(.separator())
		menu.addItem(action("Refresh now", #selector(forceRefresh), enabled: true, key: "r"))
		menu.addItem(action("Quit", #selector(quit), enabled: true, key: "q"))
	}

	private func fillHistory(_ menu: NSMenu) {
		let entries = runner.history(limit: 12)
		if entries.isEmpty {
			menu.addItem(caption("No switches yet"))
			return
		}
		for entry in entries {
			let from = entry.from.map { shorten($0) } ?? "\u{2014}"
			let title = "\(shorten(entry.to))  \u{2190}  \(from)"
			let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
			item.isEnabled = false
			item.attributedTitle = NSAttributedString(
				string:
					"\(Countdown.shortStamp(entry.at))   \(Board.providerTitles[entry.provider] ?? entry.provider)   \(title)",
				attributes: [
					.font: NSFont.systemFont(ofSize: 11),
					.foregroundColor: NSColor.secondaryLabelColor,
				])
			menu.addItem(item)
		}
	}

	private func fillSettings(_ menu: NSMenu) {
		guard let settings = latestSettings() else {
			menu.addItem(caption("Unavailable"))
			return
		}

		menu.addItem(caption("Menu bar"))
		menu.addItem(toggle("Compact button", key: "titleCompact", on: settings.titleCompact))
		menu.addItem(
			toggle(
				"Show the account name", key: "titleShowAccount", on: settings.titleShowAccount))
		menu.addItem(
			toggle(
				"Show model limits", key: "titleShowModelLimits", on: settings.titleShowModelLimits))
		let percentage = NSMenuItem(title: "Percentages", action: nil, keyEquivalent: "")
		let percentageMenu = NSMenu()
		percentageMenu.autoenablesItems = false
		for choice in ["all", "worst", "none"] {
			let label = choice == "all" ? "Every window" : choice == "worst" ? "Tightest only" : "Hide"
			percentageMenu.addItem(
				choiceItem(label, key: "titlePercentage", value: choice, current: settings.titlePercentage))
		}
		percentage.submenu = percentageMenu
		menu.addItem(percentage)

		menu.addItem(.separator())
		menu.addItem(caption("Switching"))
		let strategy = NSMenuItem(title: "Switch to the account that", action: nil, keyEquivalent: "")
		let strategyMenu = NSMenu()
		strategyMenu.autoenablesItems = false
		strategyMenu.addItem(
			choiceItem(
				"resets soonest", key: "autoStrategy", value: "soonest-reset",
				current: settings.autoStrategy))
		strategyMenu.addItem(
			choiceItem(
				"has the most left", key: "autoStrategy", value: "most-left",
				current: settings.autoStrategy))
		strategy.submenu = strategyMenu
		menu.addItem(strategy)
		let threshold = NSMenuItem(title: "Switch once a limit reaches", action: nil, keyEquivalent: "")
		let thresholdMenu = NSMenu()
		thresholdMenu.autoenablesItems = false
		for value in [80, 85, 90, 95, 99] {
			thresholdMenu.addItem(
				choiceItem(
					"\(value)%", key: "autoThresholdPercent", value: String(value),
					current: String(Int(settings.autoThresholdPercent))))
		}
		threshold.submenu = thresholdMenu
		menu.addItem(threshold)

		menu.addItem(.separator())
		menu.addItem(caption("Readings"))
		let interval = NSMenuItem(title: "Check every", action: nil, keyEquivalent: "")
		let intervalMenu = NSMenu()
		intervalMenu.autoenablesItems = false
		for value in [60, 180, 300, 600] {
			let label = value < 120 ? "\(value) seconds" : "\(value / 60) minutes"
			intervalMenu.addItem(
				choiceItem(
					label, key: "refreshIntervalSeconds", value: String(value),
					current: String(Int(settings.refreshIntervalSeconds))))
		}
		interval.submenu = intervalMenu
		menu.addItem(interval)
	}

	/// Re-reads settings so a submenu opened right after a change shows the new
	/// value. This reads the settings file only, with no network call, because it
	/// runs on the main thread while the menu is opening.
	private func latestSettings() -> Settings? {
		runner.decode(Settings.self, ["config", "--json"]) ?? board?.settings
	}

	// MARK: - Menu item builders

	private func caption(_ text: String) -> NSMenuItem {
		let item = NSMenuItem()
		item.attributedTitle = NSAttributedString(
			string: text,
			attributes: [
				.font: NSFont.systemFont(ofSize: 11),
				.foregroundColor: NSColor.tertiaryLabelColor,
			])
		item.isEnabled = false
		return item
	}

	private func action(_ title: String, _ selector: Selector, enabled: Bool, key: String = "")
		-> NSMenuItem
	{
		let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
		item.target = self
		item.isEnabled = enabled
		return item
	}

	private func bound(_ title: String, _ selector: Selector, _ payload: String) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
		item.target = self
		item.isEnabled = true
		item.representedObject = payload
		return item
	}

	private func toggle(_ title: String, key: String, on: Bool) -> NSMenuItem {
		let item = bound(title, #selector(toggleSetting(_:)), "\(key)|\(on ? "false" : "true")")
		item.state = on ? .on : .off
		return item
	}

	private func choiceItem(_ title: String, key: String, value: String, current: String)
		-> NSMenuItem
	{
		let item = bound(title, #selector(toggleSetting(_:)), "\(key)|\(value)")
		item.state = value == current ? .on : .off
		return item
	}

	private func shorten(_ email: String) -> String {
		email.split(separator: "@").first.map(String.init) ?? email
	}

	private func split(_ sender: NSMenuItem) -> [String] {
		(sender.representedObject as? String)?.components(separatedBy: "|") ?? []
	}

	// MARK: - Actions

	@objc private func seatSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["switch", parts[0], parts[1]])
	}

	@objc private func disableSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["disable", parts[0], parts[1]])
	}

	@objc private func enableSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["enable", parts[0], parts[1]])
	}

	@objc private func captureSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["save", parts[0]])
	}

	/// Removal drops a stored login, so it asks first.
	@objc private func removeSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		let alert = NSAlert()
		alert.messageText = "Remove this account?"
		alert.informativeText =
			"Its saved login is deleted from this machine. The account itself is untouched, and you can add it again from Add an account."
		alert.alertStyle = .warning
		alert.addButton(withTitle: "Remove")
		alert.addButton(withTitle: "Cancel")
		NSApp.activate(ignoringOtherApps: true)
		guard alert.runModal() == .alertFirstButtonReturn else { return }
		perform(["remove", parts[0], parts[1]])
	}

	@objc private func toggleSetting(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["config", "set", parts[0], parts[1]])
	}

	@objc private func switchToBest() {
		guard let board else { return }
		for entry in board.orderedProviders {
			runner.run(["best", entry.id])
		}
		refresh()
	}

	/// Asks for a setup token, which is how an account is added without signing
	/// the agent out of the one already in use.
	@objc private func addFromToken() {
		let alert = NSAlert()
		alert.messageText = "Add another Claude account"
		alert.informativeText =
			"Run  hotseat add  in a terminal for the guided sign-in, or run  claude setup-token  and paste the token here. Nothing you are signed into gets signed out."
		alert.addButton(withTitle: "Add")
		alert.addButton(withTitle: "Cancel")
		let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
		field.placeholderString = "sk-ant-..."
		alert.accessoryView = field
		NSApp.activate(ignoringOtherApps: true)
		alert.window.initialFirstResponder = field
		guard alert.runModal() == .alertFirstButtonReturn else { return }
		let token = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !token.isEmpty else { return }
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let ok = self.runner.run(["add-token", "claude", token]) != nil
			DispatchQueue.main.async {
				if !ok { self.reportTokenFailure() }
				self.refresh()
			}
		}
	}

	private func reportTokenFailure() {
		let alert = NSAlert()
		alert.messageText = "That token was not accepted"
		alert.informativeText =
			"Check that it was copied whole and has not expired, then try again."
		alert.alertStyle = .warning
		NSApp.activate(ignoringOtherApps: true)
		alert.runModal()
	}

	@objc private func addClaude() { perform(["add", "claude"]) }
	@objc private func addCodex() { perform(["add", "codex"]) }
	@objc private func forceRefresh() { perform(["refresh", "--json"]) }
	@objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
