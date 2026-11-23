import Foundation

/// Every read and every action goes through the CLI, which owns credentials and
/// network access. The menu bar app holds no tokens and makes no requests, so
/// it stays a renderer with a remote control attached.
final class Runner {
	private let executable: String
	private let prefix: [String]

	/// What the last failed command said, for showing to the user: its own last
	/// line, not everything it printed. A sign-in, for one, prints the agent's
	/// whole browser walkthrough before hotseat says anything.
	private(set) var lastError = ""

	/// Whether the last command was cut off for taking too long.
	private(set) var timedOut = false

	/// A runner for one particular program, which is how the checks exercise it.
	init(executable: String) {
		self.executable = executable
		prefix = []
	}

	/// Where the CLI may be, in order: inside the app, as a release carries it;
	/// beside the app; in the checkout the app was built in
	/// (<checkout>/macos/build/Hotseat.app beside <checkout>/dist/hotseat); then
	/// the usual install folders.
	static func candidates(bundle: URL, home: URL) -> [String] {
		let folder = bundle.deletingLastPathComponent()
		let checkout = folder.deletingLastPathComponent().deletingLastPathComponent()
		return [
			CommandLineLink.carried(in: bundle).path,
			folder.appendingPathComponent("hotseat").path,
			checkout.appendingPathComponent("dist/hotseat").path,
			home.appendingPathComponent(".local/bin/hotseat").path,
			"/usr/local/bin/hotseat",
			"/opt/homebrew/bin/hotseat",
		]
	}

	init() {
		if let override = ProcessInfo.processInfo.environment["HOTSEAT_BIN"], !override.isEmpty {
			executable = override
			prefix = []
			return
		}
		let candidates = Runner.candidates(
			bundle: Bundle.main.bundleURL, home: FileManager.default.homeDirectoryForCurrentUser)
		if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
			executable = found
			prefix = []
		} else {
			executable = "/usr/bin/env"
			prefix = ["hotseat"]
		}
	}

	/// Longer than any single command should take, including its own network
	/// timeouts. A command past this is killed so a stalled connection can
	/// never leave the app stuck with its busy flag set for good.
	static let timeout: TimeInterval = 90

	/// A sign-in waits on a person and a browser, so it gets far longer.
	static let signInTimeout: TimeInterval = 300

	/// How long a command asked to stop gets before it is killed, and how long
	/// its output is waited for once it has ended.
	static let grace: TimeInterval = 2

	@discardableResult
	func run(_ arguments: [String], input: String? = nil, timeout: TimeInterval = Runner.timeout) -> Data? {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: executable)
		process.arguments = prefix + arguments
		let out = Pipe()
		let err = Pipe()
		process.standardOutput = out
		process.standardError = err
		let stdin = Pipe()
		process.standardInput = stdin

		// Both streams are read as they fill, so a command that says a great
		// deal on one never blocks waiting for the other to be read.
		let output = Output()
		let streams = DispatchGroup()
		for (handle, isError) in [(out.fileHandleForReading, false), (err.fileHandleForReading, true)] {
			streams.enter()
			handle.readabilityHandler = { handle in
				let data = handle.availableData
				if data.isEmpty {
					handle.readabilityHandler = nil
					streams.leave()
				} else {
					output.append(data, isError: isError)
				}
			}
		}
		let stopReading = {
			out.fileHandleForReading.readabilityHandler = nil
			err.fileHandleForReading.readabilityHandler = nil
		}
		let exited = DispatchSemaphore(value: 0)
		process.terminationHandler = { _ in exited.signal() }
		do {
			try process.run()
		} catch {
			stopReading()
			lastError = error.localizedDescription
			return nil
		}
		// Anything secret goes over stdin, never argv, where any local process
		// could read it from the process list.
		if let input, let data = input.data(using: .utf8) {
			stdin.fileHandleForWriting.write(data)
		}
		try? stdin.fileHandleForWriting.close()

		// Past its time a command is asked to stop, then killed. Whatever it
		// started that still holds its output open is not waited for.
		timedOut = false
		if exited.wait(timeout: .now() + timeout) == .timedOut {
			timedOut = true
			let started = Runner.descendants(of: process.processIdentifier)
			process.terminate()
			for pid in started { kill(pid, SIGTERM) }
			_ = exited.wait(timeout: .now() + Runner.grace)
			kill(process.processIdentifier, SIGKILL)
			for pid in started { kill(pid, SIGKILL) }
			_ = exited.wait(timeout: .now() + Runner.grace)
		}
		_ = streams.wait(timeout: .now() + Runner.grace)
		stopReading()
		let (stdout, stderr) = output.collected()

		if timedOut {
			let minutes = Int((timeout / 60).rounded())
			let span = minutes >= 1 ? "within \(minutes) minute\(minutes == 1 ? "" : "s")" : "in time"
			lastError =
				"It did not finish \(span) and was stopped. It may have made some of its changes, so the menu shows what is in place now."
			return nil
		}
		if process.isRunning || process.terminationStatus != 0 {
			let said = String(data: stderr, encoding: .utf8) ?? ""
			let last = said.split(whereSeparator: \.isNewline)
				.map { $0.trimmingCharacters(in: .whitespaces) }
				.last { !$0.isEmpty } ?? ""
			// The CLI marks its own failure with a cross; the mark is for a terminal.
			lastError = last.hasPrefix("\u{2717}") ? String(last.dropFirst()).trimmingCharacters(in: .whitespaces) : last
			return nil
		}
		return stdout
	}

	/// Every process started by `pid`, and by those, as the process list shows
	/// them now. Read before `pid` is stopped, since its children are handed to
	/// the system once it is gone and can no longer be traced back to it.
	static func descendants(of pid: pid_t) -> [pid_t] {
		let list = Process()
		list.executableURL = URL(fileURLWithPath: "/bin/ps")
		list.arguments = ["-Ao", "pid=,ppid="]
		let pipe = Pipe()
		list.standardOutput = pipe
		list.standardError = FileHandle.nullDevice
		guard (try? list.run()) != nil else { return [] }
		let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
		list.waitUntilExit()
		var children: [pid_t: [pid_t]] = [:]
		for line in text.split(whereSeparator: \.isNewline) {
			let fields = line.split(separator: " ").compactMap { pid_t($0) }
			if fields.count == 2 { children[fields[1], default: []].append(fields[0]) }
		}
		var found: [pid_t] = []
		var pending = children[pid] ?? []
		while let next = pending.popLast() {
			found.append(next)
			pending.append(contentsOf: children[next] ?? [])
		}
		return found
	}

	func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) -> T? {
		guard let data = run(arguments) else { return nil }
		return try? JSONDecoder().decode(type, from: data)
	}

	func board() -> Board? { decode(Board.self, ["status", "--json"]) }
	/// The latest switches, or nothing when they could not be read.
	func history(limit: Int) -> [HistoryEntry]? {
		decode([HistoryEntry].self, ["logs", "--switches", "--json", "--limit", String(limit)])
	}
}

/// What a command printed, gathered from the two threads that read it.
private final class Output: @unchecked Sendable {
	private let lock = NSLock()
	private var stdout = Data()
	private var stderr = Data()

	func append(_ data: Data, isError: Bool) {
		lock.lock()
		defer { lock.unlock() }
		if isError { stderr.append(data) } else { stdout.append(data) }
	}

	func collected() -> (Data, Data) {
		lock.lock()
		defer { lock.unlock() }
		return (stdout, stderr)
	}
}

/// The CLI a released app carries, linked where a terminal, Claude Code's status
/// line and its hooks find it, so they all run the same version as the menu.
enum CommandLineLink {
	static func carried(in bundle: URL) -> URL {
		bundle.appendingPathComponent("Contents/Helpers/hotseat")
	}

	/// Whether a link's target is one this app may replace: a CLI another copy of
	/// the app carries, or nothing at all. A link to anything else, such as a
	/// build of your own, is yours and stays.
	private static func isReplaceable(_ target: String, from link: URL, _ fileManager: FileManager) -> Bool {
		// Left for the system to follow: a `..` after a linked folder leads out of
		// where that folder points, not back up the path as written.
		let path = target.hasPrefix("/") ? target : link.deletingLastPathComponent().path + "/" + target
		let resolved = URL(fileURLWithPath: path)
		if path.hasSuffix(".app/Contents/Helpers/hotseat") {
			let bundle = resolved.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
			if Bundle(url: bundle)?.bundleIdentifier == "dev.hotseat.menubar" { return true }
		}
		// Gone only when the system says there is nothing there: a target that
		// cannot be looked at, such as one in a folder that cannot be read, stays.
		var info = stat()
		return lstat(path, &info) != 0 && errno == ENOENT
	}

	/// Whether what is at `url` is a link to the carried CLI, the one this app made.
	private static func isOwnLink(_ url: URL, to carried: URL, _ fileManager: FileManager) -> Bool {
		let attributes = try? fileManager.attributesOfItem(atPath: url.path)
		guard attributes?[.type] as? FileAttributeType == .typeSymbolicLink else { return false }
		return (try? fileManager.destinationOfSymbolicLink(atPath: url.path)) == carried.path
	}

	/// Points ~/.local/bin/hotseat at the CLI this app carries. Only from an app
	/// installed in an Applications folder, and only where there is nothing, a
	/// link to nothing, or a link to another copy of the app's CLI. Says where it linked, or
	/// nil when it left things as they were. `rename` is renamex_np.
	@discardableResult
	static func ensure(
		bundle: URL, home: URL, fileManager: FileManager = .default,
		rename: (String, String, UInt32) -> Int32 = { renamex_np($0, $1, $2) }
	) -> String? {
		let carried = carried(in: bundle)
		guard fileManager.isExecutableFile(atPath: carried.path) else { return nil }
		let folder = bundle.deletingLastPathComponent().standardizedFileURL.path
		let applications = ["/Applications", home.appendingPathComponent("Applications").standardizedFileURL.path]
		guard applications.contains(folder) else { return nil }
		removexattr(carried.path, "com.apple.quarantine", 0)
		let link = home.appendingPathComponent(".local/bin/hotseat")
		let existing = try? fileManager.attributesOfItem(atPath: link.path)
		if let existing {
			guard existing[.type] as? FileAttributeType == .typeSymbolicLink,
				let target = try? fileManager.destinationOfSymbolicLink(atPath: link.path),
				target != carried.path,
				isReplaceable(target, from: link, fileManager)
			else { return nil }
		}
		try? fileManager.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
		let staged = link.deletingLastPathComponent().appendingPathComponent(".hotseat-\(UUID().uuidString)")
		guard (try? fileManager.createSymbolicLink(atPath: staged.path, withDestinationPath: carried.path)) != nil else {
			return nil
		}
		if existing == nil {
			// Put in place only if nothing has appeared there meanwhile.
			guard rename(staged.path, link.path, UInt32(RENAME_EXCL)) == 0 else {
				try? fileManager.removeItem(at: staged)
				return nil
			}
			return link.path
		}
		// Swapped with what is there in one step. What came out is then where
		// the new link was made: a link this app may replace is removed, and
		// anything else, put there meanwhile, is swapped back. If it cannot be
		// swapped back it is left where it is, never removed.
		guard rename(staged.path, link.path, UInt32(RENAME_SWAP)) == 0 else {
			try? fileManager.removeItem(at: staged)
			return nil
		}
		let displaced = try? fileManager.attributesOfItem(atPath: staged.path)
		if displaced?[.type] as? FileAttributeType == .typeSymbolicLink,
			let target = try? fileManager.destinationOfSymbolicLink(atPath: staged.path),
			isReplaceable(target, from: link, fileManager)
		{
			try? fileManager.removeItem(at: staged)
			return link.path
		}
		if rename(staged.path, link.path, UInt32(RENAME_SWAP)) == 0 {
			if isOwnLink(staged, to: carried, fileManager) {
				try? fileManager.removeItem(at: staged)
				return nil
			}
			// Something newer took the path meanwhile: it keeps it.
			_ = rename(staged.path, link.path, UInt32(RENAME_SWAP))
		}
		NSLog("hotseat: something found at %@ could not be put back and is kept at %@", link.path, staged.path)
		return nil
	}
}
