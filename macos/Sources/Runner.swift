import Foundation

/// Every read and every action goes through the CLI, which owns credentials and
/// network access. The menu bar app holds no tokens and makes no requests, so
/// it stays a renderer with a remote control attached.
final class Runner {
	private let executable: String
	private let prefix: [String]

	/// What the last failed command said, for showing to the user.
	private(set) var lastError = ""

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

		let deadline = DispatchWorkItem { [weak process] in process?.terminate() }
		DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
		// Drain both pipes before waiting, or a chatty command fills one and
		// blocks forever on the write.
		let stdout = out.fileHandleForReading.readDataToEndOfFile()
		let stderr = err.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		deadline.cancel()
		if process.terminationStatus != 0 {
			let said = String(data: stderr, encoding: .utf8)?
				.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			lastError = said.isEmpty && process.terminationReason == .uncaughtSignal
				? "hotseat did not answer in time"
				: said
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
