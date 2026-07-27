import Foundation

public enum ScriptPolicy {
    private static let forbidden = [
        "import", "export", "eval", "function", "webassembly", "require", "process", "child_process",
        "fetch", "xmlhttprequest", "websocket", "constructor", "__proto__", "file", "socket", "http",
    ]

    public static func validate(_ source: Data) throws -> String {
        guard source.count > 0, source.count <= 1_048_576,
              let text = String(data: source, encoding: .utf8), !text.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw PluginWorkerError("PLUGIN_SOURCE_INVALID")
        }
        let normalized = text.lowercased()
        guard !forbidden.contains(where: { containsToken($0, in: normalized) }) else { throw PluginWorkerError("PLUGIN_SOURCE_FORBIDDEN") }
        guard normalized.contains("registerplugin") else { throw PluginWorkerError("PLUGIN_REGISTER_MISSING") }
        return text
    }

    private static func containsToken(_ token: String, in text: String) -> Bool {
        let pattern = "(?<![a-z0-9_$])" + NSRegularExpression.escapedPattern(for: token) + "(?![a-z0-9_$])"
        return text.range(of: pattern, options: .regularExpression) != nil
    }
}
