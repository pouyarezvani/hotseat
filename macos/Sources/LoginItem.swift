import Foundation
import ServiceManagement

/// Starting at login, through the launch agent inside this app's bundle.
enum LoginItem {
	static let service = SMAppService.agent(plistName: "dev.hotseat.login.plist")

	/// Handles `--login-item on|off|status`: prints the resulting state and
	/// returns the exit status. Turning it on always registers afresh, once any
	/// earlier registration has finished stopping. A login item turned off in
	/// System Settings is reported as needing approval.
	static func run(_ request: String) -> Int32 {
		do {
			switch request {
			case "on":
				if service.status != .notRegistered {
					let outcome = Outcome()
					service.unregister { error in outcome.finish(error) }
					guard waitFor({ outcome.isDone }) else {
						throw NSError(
							domain: "Hotseat", code: 1,
							userInfo: [NSLocalizedDescriptionKey: "macOS did not finish removing the earlier login item"])
					}
					if let error = outcome.error { throw error }
				}
				try service.register()
			case "off":
				if service.status != .notRegistered { try service.unregister() }
			case "status":
				break
			default:
				FileHandle.standardError.write(Data("unknown request \(request): use on, off or status\n".utf8))
				return 2
			}
		} catch {
			if service.status == .requiresApproval || (error as NSError).code == kSMErrorLaunchDeniedByUser {
				print(describe(.requiresApproval))
				return 0
			}
			FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
			return 1
		}
		print(describe(service.status))
		return 0
	}

	static func describe(_ status: SMAppService.Status) -> String {
		switch status {
		case .enabled: return "enabled"
		case .requiresApproval: return "requires approval"
		case .notRegistered: return "off"
		case .notFound: return "not found"
		@unknown default: return "unknown"
		}
	}

	/// Runs the run loop until the condition holds or the time is up, and says whether it held.
	static func waitFor(_ condition: () -> Bool, seconds: TimeInterval = 15) -> Bool {
		let deadline = Date().addingTimeInterval(seconds)
		while !condition(), Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
		}
		return condition()
	}

	/// The result of a request macOS finishes on another thread.
	final class Outcome: @unchecked Sendable {
		private let lock = NSLock()
		private var done = false
		private var failure: Error?

		func finish(_ error: Error?) {
			lock.lock()
			defer { lock.unlock() }
			done = true
			failure = error
		}

		var isDone: Bool {
			lock.lock()
			defer { lock.unlock() }
			return done
		}

		var error: Error? {
			lock.lock()
			defer { lock.unlock() }
			return failure
		}
	}
}
