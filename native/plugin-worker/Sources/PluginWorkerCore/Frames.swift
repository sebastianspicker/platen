import Foundation

public struct Invocation: Equatable {
    public let pluginId: String
    public let version: String
    public let packageHash: String
    public let activationId: String
    public let operationId: String
    public let nonce: String
    public let capability: String
    public let documentHandle: String
    public let input: JSONValue

    public init(pluginId: String, version: String, packageHash: String, activationId: String, operationId: String, nonce: String, capability: String, documentHandle: String, input: JSONValue) {
        self.pluginId = pluginId; self.version = version; self.packageHash = packageHash
        self.activationId = activationId; self.operationId = operationId; self.nonce = nonce
        self.capability = capability; self.documentHandle = documentHandle; self.input = input
    }

    public func controlFrame() throws -> Data { try frame(controlObject()) }

    public static func decodeControl(_ data: Data) throws -> Invocation {
        let value = try JSONValue.parse(data)
        guard case let .object(fields) = value,
              Set(fields.keys) == ["activationId", "capability", "documentHandle", "input", "nonce", "operationId", "packageHash", "pluginId", "protocol", "type", "version"],
              case .number(1) = fields["protocol"], case .string("invoke") = fields["type"],
              case let .string(pluginId) = fields["pluginId"], case let .string(version) = fields["version"],
              case let .string(packageHash) = fields["packageHash"], case let .string(activation) = fields["activationId"],
              case let .string(operation) = fields["operationId"], case let .string(nonce) = fields["nonce"],
              case let .string(capability) = fields["capability"], case let .string(handle) = fields["documentHandle"],
              let input = fields["input"], validPluginId(pluginId), validSemver(version), validHex(packageHash),
              validIdentifier(activation), validIdentifier(operation), validHex(nonce), validCapability(capability), validHandle(handle) else {
            throw PluginWorkerError("PLUGIN_CONTROL_INVALID")
        }
        return Invocation(pluginId: pluginId, version: version, packageHash: packageHash, activationId: activation, operationId: operation, nonce: nonce, capability: capability, documentHandle: handle, input: input)
    }

    public func commonFields() -> [String: JSONValue] {
        ["activationId": .string(activationId), "nonce": .string(nonce), "operationId": .string(operationId),
         "packageHash": .string(packageHash), "pluginId": .string(pluginId), "protocol": .number(1), "version": .string(version)]
    }

    public func rpcFields() -> [String: JSONValue] {
        ["activationId": .string(activationId), "nonce": .string(nonce), "packageHash": .string(packageHash), "pluginId": .string(pluginId), "protocol": .number(1), "version": .string(version)]
    }

    private func controlObject() -> JSONValue {
        .object(commonFields().merging(["capability": .string(capability), "documentHandle": .string(documentHandle), "input": input, "type": .string("invoke")]) { $1 })
    }
}

public func frame(_ value: JSONValue) throws -> Data {
    let payload = try value.canonicalData()
    guard payload.count <= 65_536 else { throw PluginWorkerError("PLUGIN_FRAME_TOO_LARGE") }
    var length = UInt32(payload.count).bigEndian
    return withUnsafeBytes(of: &length) { Data($0) } + payload
}

public func unframe(_ data: Data) throws -> Data {
    guard data.count >= 5 else { throw PluginWorkerError("PLUGIN_FRAME_INVALID") }
    let length = data.prefix(4).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
    guard length > 0, length <= 65_536, data.count == Int(length) + 4 else { throw PluginWorkerError("PLUGIN_FRAME_INVALID") }
    return Data(data.dropFirst(4))
}

public func completion(_ invocation: Invocation, result: JSONValue) throws -> Data {
    try frame(.object(invocation.commonFields().merging(["result": result, "type": .string("completion")]) { $1 }))
}

public func failure(_ invocation: Invocation) throws -> Data {
    try frame(.object(invocation.commonFields().merging([
        "failure": .object(["code": .string("PLUGIN_WORKER_FAILED"), "message": .string("The plugin operation could not be completed.")]),
        "type": .string("failure"),
    ]) { $1 }))
}

private func validIdentifier(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil }
private func validPluginId(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9]*(?:[.][a-z0-9-]+)+$", options: .regularExpression) != nil }
private func validSemver(_ value: String) -> Bool { value.range(of: "^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$", options: .regularExpression) != nil }
private func validHex(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
private func validCapability(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9-]*(?:[.][a-z0-9-]+)+$", options: .regularExpression) != nil }
private func validHandle(_ value: String) -> Bool { value.range(of: "^pdfh_[0-9a-f]{64}$", options: .regularExpression) != nil }
