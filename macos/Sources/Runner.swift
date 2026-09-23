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

	init() {
		if let override = ProcessInfo.processInfo.environment["HOTSEAT_BIN"], !override.isEmpty {
			executable = override
			prefix = []
			return
		}
		// The app lives at <checkout>/macos/build/Hotseat.app and the binary at
		// <checkout>/dist/hotseat: three levels up from the bundle, not two.
		let checkout = Bundle.main.bundleURL
			.deletingLastPathComponent()
			.deletingLastPathComponent()
			.deletingLastPathComponent()
		let candidates = [
			checkout.appendingPathComponent("dist/hotseat").path,
			FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/hotseat").path,
			"/usr/local/bin/hotseat",
			"/opt/homebrew/bin/hotseat",
		]
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
		do {
			try process.run()
		} catch {
			lastError = error.localizedDescription
			return nil
		}
		// Anything secret goes over stdin, never argv, where any local process
		// could read it from the process list.
		if let input, let data = input.data(using: .utf8) {
			stdin.fileHandleForWriting.write(data)
		}
		try? stdin.fileHandleForWriting.close()

		timedOut = false
		let expired = DispatchWorkItem { [weak self, weak process] in
			self?.timedOut = true
			process?.terminate()
		}
		DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: expired)
		// Drain both pipes before waiting, or a chatty command fills one and
		// blocks forever on the write.
		let stdout = out.fileHandleForReading.readDataToEndOfFile()
		let stderr = err.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		expired.cancel()
		if process.terminationStatus != 0 {
			if timedOut {
				let minutes = Int((timeout / 60).rounded())
				lastError = minutes >= 1
					? "It did not finish within \(minutes) minute\(minutes == 1 ? "" : "s"), so nothing changed."
					: "It did not finish in time, so nothing changed."
				return nil
			}
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

	func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) -> T? {
		guard let data = run(arguments) else { return nil }
		return try? JSONDecoder().decode(type, from: data)
	}

	func board() -> Board? { decode(Board.self, ["status", "--json"]) }
	func history(limit: Int) -> [HistoryEntry] {
		decode([HistoryEntry].self, ["history", "--json", "--limit", String(limit)]) ?? []
	}
}
