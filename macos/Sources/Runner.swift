import Foundation

/// Every read and every action goes through the CLI, which owns credentials and
/// network access. The menu bar app holds no tokens and makes no requests, so
/// it stays a renderer with a remote control attached.
final class Runner {
	private let executable: String
	private let prefix: [String]

	init() {
		if let override = ProcessInfo.processInfo.environment["HOTSEAT_BIN"], !override.isEmpty {
			executable = override
			prefix = []
		} else {
			let bundled = Bundle.main.bundleURL
				.deletingLastPathComponent()
				.deletingLastPathComponent()
				.appendingPathComponent("dist/hotseat")
				.path
			if FileManager.default.isExecutableFile(atPath: bundled) {
				executable = bundled
				prefix = []
			} else {
				executable = "/usr/bin/env"
				prefix = ["hotseat"]
			}
		}
	}

	@discardableResult
	func run(_ arguments: [String]) -> Data? {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: executable)
		process.arguments = prefix + arguments
		let pipe = Pipe()
		process.standardOutput = pipe
		process.standardError = FileHandle.nullDevice
		do {
			try process.run()
		} catch {
			return nil
		}
		let data = pipe.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		return process.terminationStatus == 0 ? data : nil
	}

	func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) -> T? {
		guard let data = run(arguments) else { return nil }
		return try? JSONDecoder().decode(type, from: data)
	}

	func board() -> Board? { decode(Board.self, ["status", "--json"]) }
	func title() -> [TitleSpan] { decode([TitleSpan].self, ["title", "--json"]) ?? [] }
	func history(limit: Int) -> [HistoryEntry] {
		decode([HistoryEntry].self, ["history", "--json", "--limit", String(limit)]) ?? []
	}
}
