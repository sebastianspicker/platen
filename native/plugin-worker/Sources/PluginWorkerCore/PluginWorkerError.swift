import Foundation

public struct PluginWorkerError: Error, Equatable {
    public let code: String

    public init(_ code: String) {
        self.code = code
    }
}
