import Foundation
import JavaScriptCore

public final class DocumentRPC {
    private let invocation: Invocation
    private let requestDescriptor: Int32
    private let responseDescriptor: Int32
    private var sequence = 0

    public init(invocation: Invocation, requestDescriptor: Int32, responseDescriptor: Int32) {
        self.invocation = invocation; self.requestDescriptor = requestDescriptor; self.responseDescriptor = responseDescriptor
    }

    public func install(in context: JSContext) {
        let host = JSValue(newObjectIn: context)!
        let call: @convention(block) (String, JSValue) -> Any = { [weak self] method, value in
            guard let raw = value.toObject(),
                  let data = try? JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys]),
                  let params = try? JSONValue.parse(data) else { return NSNull() }
            return (try? self?.request(method: method, params: params).foundationValue) ?? NSNull()
        }
        host.setObject(call, forKeyedSubscript: "call" as NSString)
        context.setObject(host, forKeyedSubscript: "platenHost" as NSString)
    }

    private func request(method: String, params: JSONValue) throws -> JSONValue {
        sequence += 1
        guard method == "document.getMetadata" || method == "document.readRange", case var .object(fields) = params else { throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_INVALID") }
        fields["handle"] = .string(invocation.documentHandle)
        if method == "document.getMetadata" { guard Set(fields.keys) == ["handle"] else { throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_INVALID") } }
        if method == "document.readRange" { guard Set(fields.keys) == ["handle", "length", "offset"] else { throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_INVALID") } }
        let id = "rpc_\(sequence)"
        let envelope = invocation.rpcFields().merging(["id": .string(id), "method": .string(method), "params": .object(fields), "sequence": .number(Double(sequence)), "type": .string("request")]) { $1 }
        try writeDescriptor(requestDescriptor, data: try frame(.object(envelope)))
        let response = try JSONValue.parse(readFrameDescriptor(responseDescriptor))
        guard case let .object(fields) = response, rpcResponseMatches(fields, id: id), let type = fields["type"] else { throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_INVALID") }
        if case .string("result") = type, let value = fields["value"] { return value }
        throw PluginWorkerError("PLUGIN_DOCUMENT_RPC_DENIED")
    }

    private func rpcResponseMatches(_ fields: [String: JSONValue], id: String) -> Bool {
        guard fields["protocol"] == .number(1), fields["nonce"] == .string(invocation.nonce), fields["pluginId"] == .string(invocation.pluginId), fields["version"] == .string(invocation.version), fields["packageHash"] == .string(invocation.packageHash), fields["activationId"] == .string(invocation.activationId), fields["id"] == .string(id), fields["sequence"] == .number(Double(sequence)) else { return false }
        if fields["type"] == .string("result") { return Set(fields.keys) == ["activationId", "id", "nonce", "packageHash", "pluginId", "protocol", "sequence", "type", "value", "version"] }
        return fields["type"] == .string("error") && Set(fields.keys) == ["activationId", "error", "id", "nonce", "packageHash", "pluginId", "protocol", "sequence", "type", "version"]
    }
}
