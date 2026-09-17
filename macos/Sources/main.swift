import AppKit
import UserNotifications

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
	/// An action asked for while a refresh was in flight. It runs when the
	/// refresh finishes, rather than being dropped on the floor.
	private var queued: [[String]] = []
	/// Held so the submenu delegates are not released while their menus live.
	private var liveSubmenus: [LiveSubmenu] = []
	private var watcher: DispatchSourceFileSystemObject?
	private var watchedDescriptor: CInt = -1
	private var pendingReload: DispatchWorkItem?
	private static let menuWidth: CGFloat = 340

	/// The last notice shown per service, so a state that persists is said once.
	private var lastNotice: [String: Notice] = [:]

	func applicationDidFinishLaunching(_ notification: Notification) {
		let menu = NSMenu()
		menu.delegate = self
		menu.autoenablesItems = false
		statusItem.menu = menu
		UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
		refresh()
		watchState()
	}

	/// Watches the folder hotseat writes to, so a change made anywhere, such as
	/// adding an account in a terminal, shows here at once. The folder rather
	/// than the file: an atomic write replaces the file, which would end a
	/// watch on it, and creating the file to watch it truncated the board the
	/// CLI had just published.
	/// Where hotseat keeps its files, honouring the same override the CLI does.
	static let homePath: String =
		ProcessInfo.processInfo.environment["HOTSEAT_HOME"]
		?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hotseat").path

	/// When and how big state.json last was, which is what a real change moves.
	private var lastPublished = ""

	private static func publishedStamp() -> String {
		let path = (homePath as NSString).appendingPathComponent("state.json")
		guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return "" }
		let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
		let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
		return "\(modified):\(size)"
	}

	private func watchState() {
		let home = Self.homePath
		try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
		let descriptor = open(home, O_EVTONLY)
		guard descriptor >= 0 else { return }
		watchedDescriptor = descriptor
		let source = DispatchSource.makeFileSystemObjectSource(
			fileDescriptor: descriptor, eventMask: [.write], queue: .main)
		lastPublished = Self.publishedStamp()
		source.setEventHandler { [weak self] in
			guard let self else { return }
			// The folder changes on every refresh the app itself runs, because the
			// CLI writes its caches there. Only a new board, which the CLI
			// publishes when something was changed from a terminal, is worth a
			// reload; reacting to the caches made the app refresh without end.
			let stamp = Self.publishedStamp()
			guard stamp != self.lastPublished else { return }
			self.lastPublished = stamp
			// A burst of writes is one change.
			self.pendingReload?.cancel()
			let reload = DispatchWorkItem { [weak self] in self?.refresh() }
			self.pendingReload = reload
			DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: reload)
		}
		source.setCancelHandler { close(descriptor) }
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
			let reports = self.runner.decode([TickReport].self, ["auto", "--once", "--json"]) ?? []
			let loaded = self.runner.board()
			DispatchQueue.main.async {
				self.isBusy = false
				self.board = loaded
				self.renderTitle()
				self.announce(reports)
				self.rescheduleTimer()
				self.drainQueue()
			}
		}
	}

	/// Says what the pass did, once per change: a switch, a switch that could
	/// not happen, or every account being out of room.
	private func announce(_ reports: [TickReport]) {
		for report in reports {
			guard let notice = Notice.from(report, previous: lastNotice[report.provider]) else {
				if report.outcome == "holding", !report.detail.hasPrefix("every other account is out of room") {
					lastNotice[report.provider] = nil
				}
				continue
			}
			lastNotice[report.provider] = notice
			let content = UNMutableNotificationContent()
			content.title = notice.title
			content.body = notice.body
			let request = UNNotificationRequest(
				identifier: "hotseat.\(report.provider).\(Date().timeIntervalSince1970)", content: content, trigger: nil)
			UNUserNotificationCenter.current().add(request)
		}
	}

	private func drainQueue() {
		guard !queued.isEmpty, !isBusy else { return }
		let next = queued.removeFirst()
		perform(next)
	}

	/// Ticks every minute. Which accounts are actually re-read on a tick is the
	/// CLI's decision, made per account from how close each is to switching, so
	/// the tick itself is cheap and needs no setting.
	private func rescheduleTimer() {
		guard timer == nil else { return }
		let seconds: TimeInterval = 60
		let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { [weak self] _ in
			self?.refresh()
		}
		timer.tolerance = 10
		self.timer = timer
	}

	/// Runs a CLI action, then refreshes. If a refresh is already running the
	/// action is queued behind it, never dropped. A failure is shown, because a
	/// click that does nothing and says nothing is indistinguishable from a bug.
	private func perform(_ arguments: [String]) {
		guard !isBusy else {
			queued.append(arguments)
			return
		}
		isBusy = true
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let ok = self.runner.run(arguments) != nil
			let reason = self.runner.lastError
			DispatchQueue.main.async {
				self.isBusy = false
				if !ok { self.report(failure: arguments, reason: reason) }
				self.refresh()
			}
		}
	}

	private func report(failure arguments: [String], reason: String) {
		let alert = NSAlert()
		alert.messageText = "That did not work"
		alert.informativeText = reason.isEmpty ? "hotseat \(arguments.joined(separator: " ")) failed." : reason
		alert.alertStyle = .warning
		NSApp.activate()
		alert.runModal()
	}

	// MARK: - Title

	/// Draws the title from the board the app is holding, with no round trip.
	private func renderTitle() {
		render(spans: board.map { TitleBuilder.spans(for: $0) } ?? [])
	}

	/// Shows a switch the moment it is asked for. The switch itself takes about
	/// a second, and waiting for it made every click feel ignored.
	private func showSwitch(provider: String, accountId: String) {
		guard let board else { return }
		self.board = board.activating(provider: provider, accountId: accountId)
		renderTitle()
	}

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
		let compact = board?.settings.titleCompact ?? false
		for span in spans {
			if compact, let provider = span.provider, let mark = Logo.image(for: provider) {
				// The mark stands in for the name. An image inside text is not
				// tinted the way a template image elsewhere would be, so it is
				// painted in the text colour here, under the bar's own appearance.
				// Its bottom sits a little under the baseline so it centres on
				// the digits beside it.
				let tinted = Logo.tinted(mark, with: .labelColor, appearance: button.effectiveAppearance)
				let attachment = NSTextAttachment()
				attachment.image = tinted
				attachment.bounds = NSRect(x: 0, y: -2, width: tinted.size.width, height: tinted.size.height)
				title.append(NSAttributedString(attachment: attachment))
				continue
			}
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

	private func live(_ title: String, tip: String, _ build: @escaping (NSMenu) -> Void) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		item.toolTip = tip
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
		if board == nil, !runner.lastError.isEmpty {
			menu.addItem(
				caption(
					"hotseat could not read its files",
					tip: "The CLI answered with an error instead of the board: \(runner.lastError). Fix the file it names, or run  hotseat status  in a terminal to see the full message."))
			menu.addItem(.separator())
			appendFooter(to: menu)
			return
		}
		guard let board, !board.orderedProviders.isEmpty else {
			menu.addItem(
				caption(
					"No accounts yet",
					tip: "No account has been added. Save the login this Mac already has below, or run  hotseat add  in a terminal to sign in to one."))
			menu.addItem(
				action(
					"Save the Claude login this Mac is signed in to", #selector(addClaude), enabled: true,
					tip: "Add the account Claude Code is signed in to on this Mac right now, using its existing login. Nothing is signed out and nothing changes for Claude Code."))
			menu.addItem(
				action(
					"Save the Codex login this Mac is signed in to", #selector(addCodex), enabled: true,
					tip: "Add the account Codex is signed in to on this Mac right now, using its existing login. Nothing is signed out and nothing changes for Codex."))
			menu.addItem(
				caption(
					"To sign in to another, run  hotseat add  in a terminal.",
					tip: "hotseat add opens your browser so you can sign in to another account and adds it here. The account you are using now stays signed in."))
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
		let models = board?.settings.autoModelLimits ?? []
		let spare = state.accounts.filter { account in
			guard !account.disabled, account.id != state.activeAccountId else { return false }
			guard let room = account.headroom(countingModels: models) else { return false }
			return room >= Account.minimumUsableHeadroom
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
		item.toolTip =
			"Your \(title) accounts. The count is how many you could switch to right now: accounts that are on, not already in use, and have at least \(Int(Account.minimumUsableHeadroom))% left on their fullest limit."
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
		let row = AccountRowView(
			account: account,
			isActive: isActive,
			width: Self.menuWidth,
			onClick: canSwitch
				? { [weak self] in
					self?.showSwitch(provider: provider, accountId: account.id)
					self?.perform(["switch", provider, slot])
				} : nil)
		let bars =
			"Each bar is one of this account's limits and how much of it is used. The time on the right is when that limit resets."
		let tip: String
		if account.disabled {
			tip = "This account is turned off, so automatic switching skips it. You can still switch to it from its menu. " + bars
		} else if isActive {
			tip = "This is the account \(entry.title) is using right now. " + bars
		} else {
			tip = "Click to switch \(entry.title) to this account. " + bars + " Hover the arrow for more options."
		}
		row.toolTip = tip
		item.toolTip = tip
		item.view = row
		item.submenu = accountMenu(account, providerId: entry.id, isActive: isActive)
		return item
	}

	/// Per-account actions hang off the row itself, rather than repeating the
	/// whole account list once per verb the way a flat menu has to.
	private func accountMenu(_ account: Account, providerId: String, isActive: Bool) -> NSMenu {
		let menu = NSMenu()
		menu.autoenablesItems = false
		let selector = "\(providerId)|\(account.slot)"
		let service = Board.providerTitles[providerId] ?? providerId
		let pickup =
			providerId == "claude"
			? "Open Claude sessions, including ones in your editor, pick this up on their own within a moment."
			: "Open Codex sessions keep the old account until they restart."
		let signIn = bound(
			"Sign in again\u{2026}", #selector(signInSelector(_:)), selector,
			tip: "Open your browser to sign in to this account again, the same way adding it did. Use this when its saved login has stopped working. Nothing else is signed out, and the account you are using stays as it is.")
		// A login that stopped working is the one thing to do here, so it leads.
		let needsSignIn = account.usage?.error?.contains("no longer works") ?? false
		if needsSignIn {
			menu.addItem(signIn)
			menu.addItem(.separator())
		}
		if !isActive && !account.disabled {
			menu.addItem(
				bound(
					"Switch to this account", #selector(seatSelector(_:)), selector,
					tip: "Make this the account \(service) uses from now on. \(pickup)"))
			menu.addItem(.separator())
		}
		menu.addItem(
			bound(
				account.disabled ? "Enable" : "Disable",
				account.disabled ? #selector(enableSelector(_:)) : #selector(disableSelector(_:)),
				selector,
				tip: account.disabled
					? "Put this account back into automatic switching, so hotseat may move to it when another account runs out."
					: "Take this account out of automatic switching. hotseat will never move to it on its own. It stays saved, and you can still switch to it by hand."))
		if !needsSignIn { menu.addItem(signIn) }
		menu.addItem(
			bound(
				"Remove account", #selector(removeSelector(_:)), selector,
				tip: "Forget this account and delete its saved login from this Mac. The account itself is not affected, and you can add it again later. You will be asked to confirm."))
		if let plan = account.plan {
			menu.addItem(.separator())
			menu.addItem(caption("\(plan.capitalized) plan", tip: "The subscription plan this account is on."))
		}
		if let fetched = account.usage?.fetchedAt {
			// A failed read keeps the previous good reading, so this is when the
			// numbers shown were last confirmed, not when a read was last tried.
			menu.addItem(
				caption(
					"Last good reading \(Countdown.shortStamp(fetched))",
					tip: "When these numbers were last read successfully. If a read fails, the last good numbers stay on screen rather than going blank."))
		}
		return menu
	}

	private func appendFooter(to menu: NSMenu) {
		menu.addItem(
			action(
				"Switch now", #selector(switchToBest), enabled: true, key: "b",
				tip: "Switch right away instead of waiting for a limit to fill up. Goes to the account that resets soonest and still has something left, which is the same choice automatic switching makes."))

		menu.addItem(
			live(
				"Add an account",
				tip: "Save a login this Mac already has, or add a Claude account from a setup token. Nothing is ever signed out."
			) { [weak self] submenu in
				guard let self else { return }
				submenu.addItem(
					self.action(
						"Save the Claude login this Mac is signed in to", #selector(self.addClaude),
						enabled: true,
						tip: "Add the account Claude Code is signed in to on this Mac right now, using its existing login. Nothing is signed out and nothing changes for Claude Code."))
				submenu.addItem(
					self.action(
						"Save the Codex login this Mac is signed in to", #selector(self.addCodex),
						enabled: true,
						tip: "Add the account Codex is signed in to on this Mac right now, using its existing login. Nothing is signed out and nothing changes for Codex."))
				submenu.addItem(.separator())
				submenu.addItem(
					self.action(
						"Add a Claude account from a setup token\u{2026}", #selector(self.addFromToken),
						enabled: true,
						tip: "Add a Claude account by pasting a token you get from running  claude setup-token  in a terminal. Useful when you cannot sign in through the browser. A setup token has fewer permissions than a normal sign-in, so  hotseat add  is usually better."))
				submenu.addItem(.separator())
				submenu.addItem(
					self.caption(
						"To sign in to a new account, run  hotseat add  in a terminal.",
						tip: "hotseat add opens your browser so you can sign in to any account and adds it here. The account you are using now stays signed in."))
				submenu.addItem(
					self.caption(
						"Nothing is ever signed out.",
						tip: "Adding an account never signs any account out, here or in Claude Code or Codex. Only Remove account deletes a saved login, and only from hotseat."))
			})

		menu.addItem(
			live(
				"Recent switches",
				tip: "The last dozen times the account changed, newest first, with why it changed."
			) { [weak self] submenu in self?.fillHistory(submenu) })
		menu.addItem(
			live(
				"Settings",
				tip: "What the menu bar shows, and when hotseat switches accounts for you."
			) { [weak self] submenu in self?.fillSettings(submenu) })

		menu.addItem(.separator())
		menu.addItem(
			action(
				"Refresh now", #selector(forceRefresh), enabled: true, key: "r",
				tip: "Read every account's limits again right now instead of waiting for the next check. Numbers read under a minute ago are kept as they are."))
		menu.addItem(
			action(
				"Quit", #selector(quit), enabled: true, key: "q",
				tip: "Close the menu bar app. Automatic switching stops until you open it again with  hotseat menubar  in a terminal."))
	}

	private func fillHistory(_ menu: NSMenu) {
		let entries = runner.history(limit: 12)
		if entries.isEmpty {
			menu.addItem(caption("No switches yet", tip: "Once an account changes, by hand or automatically, it is listed here."))
			return
		}
		for entry in entries {
			let from = entry.from.map { shorten($0) } ?? "\u{2014}"
			let title = "\(from)  \u{2192}  \(shorten(entry.to))"
			let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
			item.isEnabled = false
			let why: String
			switch entry.reason {
			case "auto": why = "hotseat switched automatically because a limit filled up"
			case "manual": why = "you switched by hand"
			case "best": why = "you chose Switch now"
			case "rotate": why = "you asked for the next account in order"
			case "next": why = "you asked for the next account with room"
			default: why = entry.reason
			}
			item.toolTip =
				"At \(Countdown.shortStamp(entry.at)), \(Board.providerTitles[entry.provider] ?? entry.provider) changed from \(entry.from ?? "no account") to \(entry.to): \(why)."
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
			menu.addItem(caption("Settings could not be read", tip: "hotseat could not read its settings file. Run  hotseat config reset  in a terminal to restore the defaults."))
			return
		}

		menu.addItem(caption("Menu bar", tip: "How the text in your menu bar looks."))
		menu.addItem(
			toggle(
				"Compact title", key: "titleCompact", on: settings.titleCompact,
				tip: "Shorten the menu bar text to just the service and its fullest limit, like \u{201C}Claude 93%\u{201D}. Turn it off to see the account name and every limit."))
		menu.addItem(
			toggle(
				"Show the account name", key: "titleShowAccount", on: settings.titleShowAccount,
				tip: "Include the name of the account in use in the menu bar text, like \u{201C}Claude \u{2014} pouya\u{201D}. Has no effect while Compact title is on."))
		menu.addItem(
			toggle(
				"Show model limits", key: "titleShowModelLimits", on: settings.titleShowModelLimits,
				tip: "Some models have their own weekly limit, like Fable. Include those in the menu bar text alongside the 5-hour and weekly limits. This is only about what is shown; whether they count for switching is the setting below."))
		let percentage = submenuItem("Show in the title", tip: "Which percentages appear in the menu bar text.")
		let percentageMenu = NSMenu()
		percentageMenu.autoenablesItems = false
		let percentageChoices: [(String, String, String)] = [
			("all", "Every limit", "Show one percentage for each limit, in order: 5-hour, weekly, then any model limits, like \u{201C}87% \u{00B7} 72% \u{00B7} 95%\u{201D}."),
			("worst", "The fullest limit only", "Show a single percentage: whichever limit is closest to running out. That is the one that will trigger a switch."),
			("none", "No percentages", "Show only the service and account name, with no numbers at all."),
		]
		for (choice, label, tip) in percentageChoices {
			percentageMenu.addItem(
				choiceItem(label, key: "titlePercentage", value: choice, current: settings.titlePercentage, tip: tip))
		}
		percentage.submenu = percentageMenu
		menu.addItem(percentage)

		menu.addItem(.separator())
		menu.addItem(
			caption(
				"Switching",
				tip: "hotseat switches for you, always. When a limit on the account in use fills up, it moves to the account that resets soonest and still has something left. These settings decide when that happens and which limits count."))
		let threshold = submenuItem(
			"Switch once a limit reaches",
			tip: "How full a limit has to get before hotseat switches you to another account. Any limit counts: the 5-hour, the weekly, or a model limit you have chosen to count below.")
		let thresholdMenu = NSMenu()
		thresholdMenu.autoenablesItems = false
		for value in Self.thresholdChoices {
			thresholdMenu.addItem(
				choiceItem(
					"\(value)%", key: "autoThresholdPercent", value: String(value),
					current: String(Int(settings.autoThresholdPercent)),
					tip: Self.thresholdTip(value)))
		}
		threshold.submenu = thresholdMenu
		menu.addItem(threshold)
		menu.addItem(
			windowThresholdItem(
				"5-hour limit", key: "autoThresholdFiveHour", current: settings.autoThresholdFiveHour,
				tip: "A limit of its own for the 5-hour window. It refills quickly, so many people let it run higher than the weekly one. \u{201C}Same as above\u{201D} uses the general limit."))
		menu.addItem(
			windowThresholdItem(
				"Weekly limit", key: "autoThresholdWeekly", current: settings.autoThresholdWeekly,
				tip: "A limit of its own for the weekly window. This is the quota that expires unused, so some people spend it further than the 5-hour one. \u{201C}Same as above\u{201D} uses the general limit."))
		let models = submenuItem(
			"Also count a model\u{2019}s own limit",
			tip: "Besides the 5-hour and weekly limits, some models have their own weekly limit, like Fable. Choose whether those count when deciding to switch. Count a model you use; ignore one you do not, or hotseat will switch you away for a limit that was never in your way.")
		let modelsMenu = NSMenu()
		modelsMenu.autoenablesItems = false
		let chosen = Set(settings.autoModelLimits.map { $0.lowercased() })
		let none = bound(
			"None", #selector(toggleSetting(_:)), "autoModelLimits|",
			tip: "Only the 5-hour and weekly limits decide when to switch. A model\u{2019}s own limit is still shown, but ignored. Choose this if you do not use the models that have their own limit.")
		none.state = chosen.isEmpty ? .on : .off
		modelsMenu.addItem(none)
		let all = bound(
			"Every model", #selector(toggleSetting(_:)), "autoModelLimits|all",
			tip: "Every model\u{2019}s own limit counts. If any model you have is at its limit, hotseat switches, even when the 5-hour and weekly limits still have room.")
		all.state = chosen.contains("all") ? .on : .off
		modelsMenu.addItem(all)
		let seen = Array(
			Set((board?.orderedProviders ?? []).flatMap { $0.state.accounts.flatMap(\.modelLimitNames) })
		).sorted()
		if !seen.isEmpty { modelsMenu.addItem(.separator()) }
		for name in seen {
			// Toggling a name adds it to or removes it from the list.
			let next = chosen.contains(name.lowercased())
				? settings.autoModelLimits.filter { $0.lowercased() != name.lowercased() }
				: settings.autoModelLimits.filter { $0.lowercased() != "all" } + [name]
			let item = bound(
				name, #selector(toggleSetting(_:)), "autoModelLimits|\(next.joined(separator: ","))",
				tip: "Count \(name)\u{2019}s own weekly limit. If \(name) is at its limit, hotseat switches even when the 5-hour and weekly limits still have room. Choose this if you use \(name).")
			item.state = chosen.contains(name.lowercased()) ? .on : .off
			modelsMenu.addItem(item)
		}
		models.submenu = modelsMenu
		menu.addItem(models)

		menu.addItem(.separator())
		menu.addItem(caption("Files", tip: "The two files hotseat keeps for you to edit by hand."))
		menu.addItem(
			action(
				"Edit accounts.json\u{2026}", #selector(editAccountsFile), enabled: true,
				tip: "Open the file that lists every account and its saved login in Cursor or VS Code, whichever is installed. Add an account by writing an entry with a service and an email; delete an entry to forget it. Keep this file to yourself: it holds live logins."))
		menu.addItem(
			action(
				"Edit settings.json\u{2026}", #selector(editSettingsFile), enabled: true,
				tip: "Open your settings file in Cursor or VS Code, whichever is installed. It holds only the settings you have changed; run  hotseat config  in a terminal to see every key and its allowed values."))
	}

	@objc private func editAccountsFile() { openInEditor("accounts.json", ifMissing: nil) }
	@objc private func editSettingsFile() {
		openInEditor("settings.json", ifMissing: "{\n\t\"version\": 1\n}\n")
	}

	/// Opens one of hotseat's files in a code editor: Cursor first, then VS
	/// Code, then whatever the Mac opens JSON with.
	private func openInEditor(_ name: String, ifMissing stub: String?) {
		let path = (Self.homePath as NSString).appendingPathComponent(name)
		if let stub, !FileManager.default.fileExists(atPath: path) {
			try? stub.write(toFile: path, atomically: true, encoding: .utf8)
			try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
		}
		let file = URL(fileURLWithPath: path)
		for bundleId in Self.editorBundleIds {
			guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { continue }
			NSWorkspace.shared.open([file], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
			return
		}
		NSWorkspace.shared.open(file)
	}

	/// Cursor, then Visual Studio Code.
	static let editorBundleIds = ["com.todesktop.230313mzl4w4u92", "com.microsoft.VSCode"]

	/// A submenu giving one window a limit of its own, or none.
	private func windowThresholdItem(_ title: String, key: String, current: Double, tip: String) -> NSMenuItem {
		let item = submenuItem(title, tip: tip)
		let submenu = NSMenu()
		submenu.autoenablesItems = false
		submenu.addItem(
			choiceItem(
				"Same as above", key: key, value: "0", current: String(Int(current)),
				tip: "This window follows the general limit above, with no limit of its own."))
		submenu.addItem(.separator())
		for value in Self.thresholdChoices {
			submenu.addItem(
				choiceItem(
					"\(value)%", key: key, value: String(value), current: String(Int(current)),
					tip: "Switch once this window is \(value)% used, whatever the general limit says. The other windows keep theirs."))
		}
		item.submenu = submenu
		return item
	}

	/// Early, a little early, and then every point from the default up to the
	/// very end, because the right spot between 90 and 99 depends on how long
	/// a turn runs.
	static let thresholdChoices: [Int] = [80, 85] + Array(90...99)

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

	/// Re-reads settings so a submenu opened right after a change shows the new
	/// value. This reads the settings file only, with no network call, because it
	/// runs on the main thread while the menu is opening.
	private func latestSettings() -> Settings? {
		runner.decode(Settings.self, ["config", "--json"]) ?? board?.settings
	}

	// MARK: - Menu item builders

	private func caption(_ text: String, tip: String? = nil) -> NSMenuItem {
		let item = NSMenuItem()
		item.toolTip = tip
		item.attributedTitle = NSAttributedString(
			string: text,
			attributes: [
				.font: NSFont.systemFont(ofSize: 11),
				.foregroundColor: NSColor.tertiaryLabelColor,
			])
		item.isEnabled = false
		return item
	}

	private func action(
		_ title: String, _ selector: Selector, enabled: Bool, key: String = "", tip: String? = nil
	) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
		item.target = self
		item.isEnabled = enabled
		item.toolTip = tip
		return item
	}

	private func bound(_ title: String, _ selector: Selector, _ payload: String, tip: String? = nil)
		-> NSMenuItem
	{
		let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
		item.target = self
		item.isEnabled = true
		item.representedObject = payload
		item.toolTip = tip
		return item
	}

	private func toggle(_ title: String, key: String, on: Bool, tip: String) -> NSMenuItem {
		let item = bound(title, #selector(toggleSetting(_:)), "\(key)|\(on ? "false" : "true")", tip: tip)
		item.state = on ? .on : .off
		return item
	}

	private func choiceItem(_ title: String, key: String, value: String, current: String, tip: String)
		-> NSMenuItem
	{
		let item = bound(title, #selector(toggleSetting(_:)), "\(key)|\(value)", tip: tip)
		item.state = value == current ? .on : .off
		return item
	}

	private func submenuItem(_ title: String, tip: String) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		item.toolTip = tip
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
		if let account = board?.providers[parts[0]]?.accounts.first(where: { String($0.slot) == parts[1] }) {
			showSwitch(provider: parts[0], accountId: account.id)
		}
		perform(["switch", parts[0], parts[1]])
	}

	/// A sign-in waits on a person in a browser, so it runs beside the regular
	/// refreshes instead of holding them up, and says how it ended.
	@objc private func signInSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		let email = board?.providers[parts[0]]?.accounts.first(where: { String($0.slot) == parts[1] })?.email ?? "the account"
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let signer = Runner()
			let ok = signer.run(["signin", parts[0], parts[1]], timeout: Runner.signInTimeout) != nil
			let reason = signer.lastError
			DispatchQueue.main.async {
				if ok {
					let content = UNMutableNotificationContent()
					content.title = "Signed in to \(email) again"
					content.body = "Its saved login was replaced. Nothing else was signed out."
					UNUserNotificationCenter.current().add(
						UNNotificationRequest(identifier: "hotseat.signin.\(Date().timeIntervalSince1970)", content: content, trigger: nil))
				} else {
					self.report(failure: ["signin", parts[0], parts[1]], reason: reason)
				}
				self.refresh()
			}
		}
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

	/// Removal drops a stored login, so it asks first.
	@objc private func removeSelector(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		let alert = NSAlert()
		alert.messageText = "Remove this account?"
		alert.informativeText =
			"Its saved login is deleted from this machine. The account itself is untouched, and you can add it again from Add an account."
		alert.alertStyle = .warning
		let remove = alert.addButton(withTitle: "Remove")
		let cancel = alert.addButton(withTitle: "Cancel")
		// Return must never delete. Cancel takes Return and Escape; Remove is a
		// deliberate click.
		remove.keyEquivalent = ""
		remove.hasDestructiveAction = true
		cancel.keyEquivalent = "\r"
		NSApp.activate()
		guard alert.runModal() == .alertFirstButtonReturn else { return }
		perform(["remove", parts[0], parts[1]])
	}

	@objc private func toggleSetting(_ sender: NSMenuItem) {
		let parts = split(sender)
		guard parts.count == 2 else { return }
		perform(["config", "set", parts[0], parts[1]])
	}

	@objc private func switchToBest() {
		guard let board, !isBusy else { return }
		let providers = board.orderedProviders.map(\.id)
		isBusy = true
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			for provider in providers { self.runner.run(["best", provider]) }
			DispatchQueue.main.async {
				self.isBusy = false
				self.refresh()
			}
		}
	}

	/// Asks for a setup token, which is how an account is added without signing
	/// the agent out of the one already in use.
	@objc private func addFromToken() {
		let alert = NSAlert()
		alert.messageText = "Add a Claude account from a setup token"
		alert.informativeText =
			"Run  claude setup-token  in a terminal and paste what it prints here. Nothing you are signed in to gets signed out. A setup token has fewer permissions than a full sign-in, so for most accounts  hotseat add  in a terminal is the better way."
		alert.addButton(withTitle: "Add")
		alert.addButton(withTitle: "Cancel")
		let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
		field.placeholderString = "sk-ant-..."
		alert.accessoryView = field
		NSApp.activate()
		alert.window.initialFirstResponder = field
		guard alert.runModal() == .alertFirstButtonReturn else { return }
		let token = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !token.isEmpty else { return }
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let ok = self.runner.run(["add-token", "claude", "-"], input: token + "\n") != nil
			let reason = self.runner.lastError
			DispatchQueue.main.async {
				if !ok { self.reportTokenFailure(reason) }
				self.refresh()
			}
		}
	}

	private func reportTokenFailure(_ reason: String) {
		let alert = NSAlert()
		alert.messageText = "The account was not added"
		alert.informativeText = reason.isEmpty ? "Check the token was copied whole, then try again." : reason
		alert.alertStyle = .warning
		NSApp.activate()
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
