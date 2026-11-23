import AppKit
import UserNotifications

/// The dropdown is built around one idea: an account row IS the switch.
/// Clicking a row switches to that account, so the common case needs no verb.
/// Everything else lives in the row's options and the buttons underneath.
final class AppDelegate: NSObject, NSApplicationDelegate {
	private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
	private let runner = Runner()
	private var board: Board? {
		didSet { model.board = board }
	}
	private let model = PanelModel()
	private lazy var dropdown = DropdownController(model: model, actions: panelActions())
	private var timer: Timer?
	private var isBusy = false
	/// Between the Mac going to sleep and waking fully. The brief wakes a
	/// closed lid makes in between are not full wakes, and a pass there could
	/// renew a login and fall asleep before the new token comes back.
	private var isAsleep = false
	/// An action asked for while a refresh was in flight. It runs when the
	/// refresh finishes, rather than being dropped on the floor.
	private var queued: [[String]] = []
	/// The latest switches, for the History menu, read in the background
	/// whenever the newest log file changes.
	private var history: [HistoryEntry] = [] {
		didSet { model.history = history }
	}
	/// The newest log file as it was when the switches were last read.
	private var historyStamp: String?
	/// Settings changed from the menu whose writes have not finished, kept on
	/// the board over whatever a refresh loads until they have.
	private var pendingSettings: [(key: String, value: String)] = []
	private var watcher: DispatchSourceFileSystemObject?
	private var watchedDescriptor: CInt = -1
	private var pendingReload: DispatchWorkItem?

	/// The last notice shown per service, so a state that persists is said once.
	private var lastNotice: [String: Notice] = [:]

	func applicationDidFinishLaunching(_ notification: Notification) {
		CommandLineLink.ensure(bundle: Bundle.main.bundleURL, home: FileManager.default.homeDirectoryForCurrentUser)
		statusItem.button?.target = self
		statusItem.button?.action = #selector(toggleDropdown)
		statusItem.button?.sendAction(on: [.leftMouseDown, .rightMouseDown])
		UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
		let workspace = NSWorkspace.shared.notificationCenter
		workspace.addObserver(
			self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
		workspace.addObserver(
			self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)
		refresh()
		watchState()
	}

	@objc private func willSleep() {
		isAsleep = true
		timer?.invalidate()
		timer = nil
	}

	@objc private func didWake() {
		isAsleep = false
		refresh()
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
		guard !isBusy, !isAsleep else { return }
		isBusy = true
		let readFor = historyStamp
		DispatchQueue.global(qos: .utility).async { [weak self] in
			guard let self else { return }
			let reports = self.runner.decode([TickReport].self, ["auto", "--once", "--json"]) ?? []
			let loaded = self.runner.board()
			let stamp = Self.historyFileStamp()
			let history = stamp == readFor ? nil : self.runner.history(limit: 12)
			DispatchQueue.main.async {
				self.isBusy = false
				self.model.loadError = loaded == nil ? self.runner.lastError : ""
				if let history {
					self.history = history
					self.historyStamp = stamp
				}
				self.board = self.pendingSettings.reduce(loaded) { board, change in
					board?.withSetting(change.key, change.value)
				}
				self.renderTitle()
				self.announce(reports)
				self.rescheduleTimer()
				self.drainQueue()
			}
		}
	}

	/// The newest daily log's name, size and when it last changed, or nothing
	/// while there is no log yet. Any switch changes them.
	private static func historyFileStamp() -> String? {
		let dir = (homePath as NSString).appendingPathComponent("logs")
		guard
			let newest = (try? FileManager.default.contentsOfDirectory(atPath: dir))?
				.filter({ $0.hasSuffix(".jsonl") }).max(),
			let attributes = try? FileManager.default.attributesOfItem(
				atPath: (dir as NSString).appendingPathComponent(newest))
		else { return nil }
		let changed = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
		return "\(newest)|\(changed)|\((attributes[.size] as? NSNumber)?.intValue ?? 0)"
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
				if arguments.count == 4, arguments[0] == "config", arguments[1] == "set",
					let index = self.pendingSettings.firstIndex(where: {
						$0.key == arguments[2] && $0.value == arguments[3]
					})
				{
					self.pendingSettings.remove(at: index)
				}
				if !ok { self.report(failure: arguments, reason: reason) }
				self.refresh()
			}
		}
	}

	private func report(failure arguments: [String], reason: String, title: String = "That did not work") {
		dropdown.close()
		let alert = NSAlert()
		alert.messageText = title
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

	// MARK: - Dropdown

	@objc private func toggleDropdown() {
		guard let button = statusItem.button else { return }
		dropdown.toggle(from: button)
	}

	/// What each control in the dropdown does. Built once; every closure
	/// reads the board as it is when the control is used.
	private func panelActions() -> PanelActions {
		PanelActions(
			switchTo: { [weak self] provider, account in self?.seat(provider: provider, account: account) },
			signIn: { [weak self] provider, account in self?.signIn(provider: provider, account: account) },
			setEnabled: { [weak self] provider, account, enabled in
				self?.perform([enabled ? "enable" : "disable", provider, "id:\(account.id)"])
			},
			remove: { [weak self] provider, account in self?.remove(provider: provider, account: account) },
			useReset: { [weak self] provider, account, reset in
				self?.useReset(provider: provider, account: account, reset: reset)
			},
			setSetting: { [weak self] key, value in self?.changeSetting(key, value) },
			switchNow: { [weak self] in self?.switchToBest() },
			refresh: { [weak self] in self?.perform(["refresh", "--json"]) },
			quit: { NSApp.terminate(nil) },
			add: { [weak self] provider in self?.perform(["add", provider]) },
			addFromToken: { [weak self] in self?.addFromToken() },
			editAccounts: { [weak self] in self?.openInEditor("accounts.json", ifMissing: nil) },
			editSettings: { [weak self] in
				self?.openInEditor("settings.json", ifMissing: "{\n\t\"version\": 1\n}\n")
			})
	}

	/// Opens one of hotseat's files in a code editor: Cursor first, then VS
	/// Code, then whatever the Mac opens JSON with.
	private func openInEditor(_ name: String, ifMissing stub: String?) {
		dropdown.close()
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

	// MARK: - Actions

	/// An account is named by its id alone, which neither renumbering nor a
	/// name can move to another account.
	private func seat(provider: String, account: Account) {
		showSwitch(provider: provider, accountId: account.id)
		perform(["switch", provider, "id:\(account.id)"])
	}

	/// A sign-in waits on a person in a browser, so it runs beside the regular
	/// refreshes instead of holding them up, and says how it ended.
	private func signIn(provider: String, account: Account) {
		dropdown.close()
		let email = account.email
		let selector = "id:\(account.id)"
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let signer = Runner()
			let ok = signer.run(["signin", provider, selector], timeout: Runner.signInTimeout) != nil
			let reason = signer.timedOut
				? "The sign-in did not finish within 5 minutes and was stopped. If you finished signing in to \(email) in the browser, it may have been saved; the dropdown shows what is in place now. Otherwise, try again."
				: signer.lastError
			DispatchQueue.main.async {
				if ok {
					let content = UNMutableNotificationContent()
					content.title = "Signed in to \(email) again"
					content.body = "Its saved login was replaced. Nothing else was signed out."
					UNUserNotificationCenter.current().add(
						UNNotificationRequest(identifier: "hotseat.signin.\(Date().timeIntervalSince1970)", content: content, trigger: nil))
				} else {
					self.report(failure: ["signin", provider, selector], reason: reason, title: "\(email) was not signed in")
				}
				self.refresh()
			}
		}
	}

	/// Removal drops a stored login, so it asks first.
	private func remove(provider: String, account: Account) {
		dropdown.close()
		let alert = NSAlert()
		alert.messageText = "Remove \(account.displayName)?"
		alert.informativeText =
			"Its saved login is deleted from this machine. The account itself is untouched, and you can add it again from Add account."
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
		perform(["remove", provider, "id:\(account.id)"])
	}

	/// Asks first, naming the account and what will start over, and uses the
	/// reset only on a yes.
	private func useReset(provider: String, account: Account, reset: LimitReset) {
		dropdown.close()
		guard reset.canUse else { return }
		let alert = NSAlert()
		alert.messageText = "Use the \(reset.title) on \(account.displayName)?"
		var lines: [String] = []
		if let clears = reset.clearsText { lines.append("This empties \(clears) now.") }
		if let expiry = Countdown.longStamp(reset.expiresAt) { lines.append("Unused, it would expire \(expiry).") }
		lines.append("A reset can't be given back once it is used.")
		alert.informativeText = lines.joined(separator: " ")
		let use = alert.addButton(withTitle: "Use Reset")
		let cancel = alert.addButton(withTitle: "Cancel")
		use.keyEquivalent = ""
		cancel.keyEquivalent = "\r"
		NSApp.activate()
		guard alert.runModal() == .alertFirstButtonReturn, reset.canUse else { return }
		perform(["use-reset", provider, "id:\(account.id)"] + reset.allIds)
	}

	/// Shown at once, so the dropdown reads the new value and a second click
	/// reverses it; the refresh after the command puts back whatever was
	/// actually saved.
	private func changeSetting(_ key: String, _ value: String) {
		pendingSettings.append((key: key, value: value))
		board = board?.withSetting(key, value)
		renderTitle()
		perform(["config", "set", key, value])
	}

	/// Queued like any other action, so a click while a refresh runs is kept,
	/// and a service it could not move is said so. A service with no enabled
	/// account other than the one in use is left out rather than reported every
	/// time.
	private func switchToBest() {
		guard let board else { return }
		for entry in board.orderedProviders
		where entry.state.accounts.contains(where: { !$0.disabled && $0.id != entry.state.activeAccountId }) {
			perform(["best", entry.id])
		}
	}

	/// Asks for a setup token, which is how an account is added without signing
	/// the agent out of the one already in use.
	private func addFromToken() {
		dropdown.close()
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
			let adder = Runner()
			let ok = adder.run(["add-token", "claude", "-"], input: token + "\n") != nil
			let reason = adder.lastError
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
}

if let flag = CommandLine.arguments.firstIndex(of: "--login-item") {
	let request = CommandLine.arguments.indices.contains(flag + 1) ? CommandLine.arguments[flag + 1] : "status"
	exit(LoginItem.run(request))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
