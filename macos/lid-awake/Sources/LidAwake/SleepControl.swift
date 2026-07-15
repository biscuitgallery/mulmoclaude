import Foundation

enum SleepControlError: Error {
    case cancelled
    case scriptFailure(String)
}

/// Wraps `pmset disablesleep`, the only supported way to keep a MacBook awake
/// while the lid is closed without an external display. Writing the setting
/// requires root, so it runs through an admin-privileged AppleScript prompt.
enum SleepControl {
    private static let pmsetPath = "/usr/bin/pmset"

    /// Reads the current state from `pmset -g` ("SleepDisabled 1" when active).
    static func isSleepDisabled() -> Bool {
        guard let output = runPmsetStatus() else { return false }
        return parseSleepDisabled(from: output)
    }

    static func parseSleepDisabled(from pmsetOutput: String) -> Bool {
        for line in pmsetOutput.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("SleepDisabled") {
                return trimmed.hasSuffix("1")
            }
        }
        return false
    }

    static func setSleepDisabled(_ disabled: Bool) -> Result<Void, SleepControlError> {
        let command = "\(pmsetPath) -a disablesleep \(disabled ? 1 : 0)"
        let prompt = L10n.authPrompt.replacingOccurrences(of: "\"", with: "\\\"")
        let source = "do shell script \"\(command)\" with administrator privileges with prompt \"\(prompt)\""
        guard let script = NSAppleScript(source: source) else {
            return .failure(.scriptFailure("NSAppleScript init failed"))
        }
        var errorInfo: NSDictionary?
        script.executeAndReturnError(&errorInfo)
        return mapScriptResult(errorInfo)
    }

    private static func mapScriptResult(_ errorInfo: NSDictionary?) -> Result<Void, SleepControlError> {
        guard let errorInfo else { return .success(()) }
        // -128 = user cancelled the password dialog; not a real failure.
        if let code = errorInfo[NSAppleScript.errorNumber] as? Int, code == -128 {
            return .failure(.cancelled)
        }
        let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "\(errorInfo)"
        return .failure(.scriptFailure(message))
    }

    private static func runPmsetStatus() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: pmsetPath)
        process.arguments = ["-g"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}
